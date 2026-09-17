import { promises as fs } from "node:fs";
import * as path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { entryToUtf8, parseCustomArchive } from "./archive.js";
import { detectBlobRoots } from "./paths.js";
import type { BookInfo, BookMetadata, ChapterNode } from "./types.js";

export const DEFAULT_VIEWPORT = { width: 957, height: 1199 };

const MEDIA_EXTENSIONS = new Set([
  ".mp3",
  ".mp4",
  ".m4a",
  ".m4v",
  ".ogg",
  ".oga",
  ".ogv",
  ".wav",
  ".wave",
  ".webm",
  ".mov",
  ".aac",
  ".flac",
  ".opus",
  ".vtt",
  ".srt",
]);

export function isMediaPath(filePath: string): boolean {
  const withoutQuery = filePath.split(/[?#]/, 1)[0] ?? filePath;
  const extension = path.posix.extname(withoutQuery).toLowerCase();
  return MEDIA_EXTENSIONS.has(extension);
}

function isMediaMimeType(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase().split(";")[0] ?? "";
  return (
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized === "application/ogg" ||
    normalized === "application/vnd.apple.mpegurl" ||
    normalized === "text/vtt"
  );
}
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function xmlText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const directText = record["#text"];
    if (
      typeof directText === "string" ||
      typeof directText === "number" ||
      typeof directText === "bigint"
    ) {
      return String(directText).trim();
    }

    for (const nested of Object.values(record)) {
      const nestedText = xmlText(nested);
      if (nestedText) {
        return nestedText;
      }
    }
  }

  return "";
}

export function parseViewportFromXhtml(xhtml: string): { width: number; height: number } {
  const viewportMetaTagMatch = xhtml.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  if (!viewportMetaTagMatch) {
    return DEFAULT_VIEWPORT;
  }

  const viewportMetaTag = viewportMetaTagMatch[0];
  const contentMatch = viewportMetaTag.match(/content=["']([^"']+)["']/i);
  if (!contentMatch?.[1]) {
    return DEFAULT_VIEWPORT;
  }

  const content = contentMatch[1];
  const widthMatch = content.match(/width\s*=\s*([0-9.]+)/i);
  const heightMatch = content.match(/height\s*=\s*([0-9.]+)/i);
  const width = widthMatch ? Number(widthMatch[1]) : DEFAULT_VIEWPORT.width;
  const height = heightMatch ? Number(heightMatch[1]) : DEFAULT_VIEWPORT.height;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_VIEWPORT;
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function parseBookFromOpf(opfXml: string, opfPath: string): BookMetadata {
  const parsed = XML.parse(opfXml) as Record<string, unknown>;
  const pkg = parsed.package as Record<string, unknown>;
  if (!pkg) {
    throw new Error("Invalid OPF: missing package");
  }

  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  const packageUniqueIdentifierRef =
    typeof pkg["@_unique-identifier"] === "string" ? pkg["@_unique-identifier"] : "";

  const titleRaw = asArray(metadata["dc:title"])[0];
  const title = xmlText(titleRaw) || "Untitled";

  const identifierTags = Array.from(
    opfXml.matchAll(/<dc:identifier([^>]*)>([\s\S]*?)<\/dc:identifier>/gi),
  ).map((match) => {
    const rawAttrs = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const value = rawValue.replace(/<[^>]+>/g, "").trim();
    const idMatch = rawAttrs.match(/\bid\s*=\s*["']([^"']+)["']/i);

    return {
      id: idMatch?.[1] ?? "",
      value,
    };
  });

  const identifierById = new Map(
    identifierTags.filter((item) => item.id && item.value).map((item) => [item.id, item.value]),
  );

  const identifiers = identifierTags.map((item) => item.value).filter(Boolean);
  const identifierWithDigits = identifiers.find((item) => /\d{10,17}/.test(item));
  const preferredIdentifierFromRef =
    packageUniqueIdentifierRef && identifierById.has(packageUniqueIdentifierRef)
      ? identifierById.get(packageUniqueIdentifierRef)
      : undefined;

  const isbn =
    preferredIdentifierFromRef?.match(/\d{10,17}/)?.[0] ??
    identifierWithDigits?.match(/\d{10,17}/)?.[0] ??
    identifiers[0] ??
    path.basename(opfPath, path.extname(opfPath));

  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const manifestItems = asArray(manifest.item).map((item) => item as Record<string, unknown>);
  const idToHref = new Map<string, string>();
  const idToMediaType = new Map<string, string>();

  for (const item of manifestItems) {
    const id = typeof item["@_id"] === "string" ? item["@_id"] : "";
    const href = typeof item["@_href"] === "string" ? item["@_href"] : "";
    const mediaType = typeof item["@_media-type"] === "string" ? item["@_media-type"] : "";
    if (id && href) {
      idToHref.set(id, href);
      if (mediaType) {
        idToMediaType.set(id, mediaType);
      }
    }
  }

  const spine = (pkg.spine ?? {}) as Record<string, unknown>;
  const itemRefs = asArray(spine.itemref).map((item) => item as Record<string, unknown>);
  const opfDir = path.posix.dirname(opfPath);
  const pagePaths = itemRefs
    .map((itemRef) => {
      const idRef = typeof itemRef["@_idref"] === "string" ? itemRef["@_idref"] : "";
      const href = idToHref.get(idRef);
      if (!href) {
        return "";
      }
      return path.posix.normalize(path.posix.join(opfDir, href));
    })
    .filter((item) => item.endsWith(".xhtml") || item.endsWith(".html"));

  const tocItem = manifestItems.find((item) => {
    const properties = typeof item["@_properties"] === "string" ? item["@_properties"] : "";
    const mediaType = typeof item["@_media-type"] === "string" ? item["@_media-type"] : "";
    return properties.includes("nav") || mediaType.includes("nav");
  });

  const navPath =
    tocItem && typeof tocItem["@_href"] === "string"
      ? path.posix.normalize(path.posix.join(opfDir, tocItem["@_href"]))
      : undefined;

  const ncxId = typeof spine["@_toc"] === "string" ? spine["@_toc"] : "";
  const ncxHref = ncxId ? idToHref.get(ncxId) : undefined;
  const fallbackNcx = manifestItems.find((item) => {
    const mediaType = typeof item["@_media-type"] === "string" ? item["@_media-type"] : "";
    const id = typeof item["@_id"] === "string" ? item["@_id"] : "";
    return (
      mediaType === "application/x-dtbncx+xml" ||
      idToMediaType.get(id) === "application/x-dtbncx+xml"
    );
  });

  const tocHref =
    ncxHref ??
    (fallbackNcx && typeof fallbackNcx["@_href"] === "string" ? fallbackNcx["@_href"] : undefined);

  const tocPath = tocHref ? path.posix.normalize(path.posix.join(opfDir, tocHref)) : undefined;

  const pagePathSet = new Set(pagePaths);
  const mediaPaths: string[] = [];
  const seenMedia = new Set<string>();
  for (const item of manifestItems) {
    const href = typeof item["@_href"] === "string" ? item["@_href"] : "";
    const mediaType = typeof item["@_media-type"] === "string" ? item["@_media-type"] : "";
    if (!href) {
      continue;
    }
    if (!isMediaMimeType(mediaType) && !isMediaPath(href)) {
      continue;
    }
    const normalized = path.posix.normalize(path.posix.join(opfDir, href.split("#")[0] ?? href));
    if (!normalized || pagePathSet.has(normalized) || seenMedia.has(normalized)) {
      continue;
    }
    seenMedia.add(normalized);
    mediaPaths.push(normalized);
  }

  return { title, isbn, opfPath, pagePaths, mediaPaths, tocPath, navPath };
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchingCloseTag(html: string, contentStart: number, tagName: string): number {
  const pattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  pattern.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const isClose = match[0].startsWith("</");
    const isSelfClosing = match[0].endsWith("/>");
    if (isSelfClosing) {
      continue;
    }
    if (isClose) {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth === 0 && match.index !== undefined) {
      return match.index;
    }
  }
  return -1;
}

function extractNestedLists(liInner: string): string[] {
  const lists: string[] = [];
  const pattern = /<(ol|ul)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(liInner))) {
    const tagName = (match[1] ?? "ol").toLowerCase();
    const contentStart = match.index + match[0].length;
    const closeIndex = findMatchingCloseTag(liInner, contentStart, tagName);
    if (closeIndex === -1) {
      continue;
    }
    lists.push(liInner.slice(contentStart, closeIndex));
    pattern.lastIndex = closeIndex + `</${tagName}>`.length;
  }
  return lists;
}

function parseListItems(
  listInnerHtml: string,
  opfDir: string,
  pageIndexByPath: Map<string, number>,
): ChapterNode[] {
  const items: ChapterNode[] = [];
  const liOpenPattern = /<li\b[^>]*>/gi;
  let liOpen: RegExpExecArray | null;
  let cursor = 0;
  liOpenPattern.lastIndex = 0;

  while (cursor < listInnerHtml.length) {
    liOpenPattern.lastIndex = cursor;
    liOpen = liOpenPattern.exec(listInnerHtml);
    if (!liOpen || liOpen.index === undefined) {
      break;
    }
    const contentStart = liOpen.index + liOpen[0].length;
    const closeIndex = findMatchingCloseTag(listInnerHtml, contentStart, "li");
    if (closeIndex === -1) {
      break;
    }
    const liInner = listInnerHtml.slice(contentStart, closeIndex);
    cursor = closeIndex + "</li>".length;

    const anchorMatch = liInner.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const rawHref = anchorMatch?.[1]?.trim();
    const rawTitle = anchorMatch?.[2] ?? "";
    const nestedLists = extractNestedLists(liInner);
    const children = nestedLists.flatMap((nested) =>
      parseListItems(nested, opfDir, pageIndexByPath),
    );

    if (rawHref) {
      const hrefNoHash = rawHref.split("#")[0] ?? rawHref;
      if (hrefNoHash) {
        const normalizedHref = path.posix.normalize(path.posix.join(opfDir, hrefNoHash));
        const title = stripHtmlTags(rawTitle) || hrefNoHash;
        items.push({
          title,
          href: normalizedHref,
          pageIndex: pageIndexByPath.get(normalizedHref),
          children,
        });
        continue;
      }
    }

    // List item without a link (e.g. a grouping label): promote its children.
    items.push(...children);
  }

  return items;
}

function parseHtmlTocDocument(
  html: string,
  tocPath: string,
  pageIndexByPath: Map<string, number>,
): ChapterNode[] {
  const opfDir = path.posix.dirname(tocPath);

  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
  const navMarkup = navMatch?.[1] ?? html;

  const topLists = extractNestedLists(navMarkup);
  const source = topLists.length ? topLists.join("") : navMarkup;

  return parseListItems(source, opfDir, pageIndexByPath);
}

function parseNcxNode(
  node: Record<string, unknown>,
  tocDir: string,
  pageIndexByPath: Map<string, number>,
): ChapterNode {
  const navLabel = node.navLabel as Record<string, unknown>;
  const labelText = navLabel ? xmlText(navLabel.text ?? navLabel) : "";
  const content = node.content as Record<string, unknown>;
  const src = typeof content?.["@_src"] === "string" ? content["@_src"] : "";
  const hrefNoHash = src.split("#")[0] ?? src;
  const href = path.posix.normalize(path.posix.join(tocDir, hrefNoHash));

  const children = asArray(node.navPoint)
    .map((child) => parseNcxNode(child as Record<string, unknown>, tocDir, pageIndexByPath))
    .filter((child) => child.href);

  return {
    title: labelText || hrefNoHash || "Untitled",
    href,
    pageIndex: pageIndexByPath.get(href),
    children,
  };
}

function buildPageIndexByPath(pagePaths: string[]): Map<string, number> {
  const pageIndexByPath = new Map<string, number>();
  for (let index = 0; index < pagePaths.length; index += 1) {
    const pagePath = pagePaths[index];
    if (pagePath) {
      pageIndexByPath.set(pagePath, index + 1);
    }
  }
  return pageIndexByPath;
}

function parseNcxDocument(
  ncx: string,
  tocPath: string,
  pageIndexByPath: Map<string, number>,
): ChapterNode[] {
  const parsed = XML.parse(ncx) as Record<string, unknown>;
  const ncxRoot = parsed.ncx as Record<string, unknown>;
  const navMap = (ncxRoot?.navMap ?? {}) as Record<string, unknown>;
  const navPoints = asArray(navMap.navPoint).map((item) => item as Record<string, unknown>);
  const tocDir = path.posix.dirname(tocPath);
  return navPoints.map((node) => parseNcxNode(node, tocDir, pageIndexByPath));
}

export function extractChaptersFromContents(params: {
  navHtml?: string;
  navPath?: string;
  ncxXml?: string;
  tocPath?: string;
  pagePaths: string[];
}): ChapterNode[] {
  const pageIndexByPath = buildPageIndexByPath(params.pagePaths);

  if (params.navHtml !== undefined && params.navPath) {
    try {
      const chapters = parseHtmlTocDocument(params.navHtml, params.navPath, pageIndexByPath);
      if (chapters.length) {
        return chapters;
      }
    } catch {
      // ignore and try ncx
    }
  }

  if (params.ncxXml !== undefined && params.tocPath) {
    try {
      return parseNcxDocument(params.ncxXml, params.tocPath, pageIndexByPath);
    } catch {
      return [];
    }
  }

  return [];
}

export function extractChaptersFromArchive(buffer: Buffer, book: BookInfo): ChapterNode[] {
  const archive = parseCustomArchive(buffer);
  const entryByName = new Map(archive.entries.map((entry) => [entry.name, entry]));

  let navHtml: string | undefined;
  if (book.navPath) {
    const navEntry = entryByName.get(book.navPath);
    if (navEntry) {
      try {
        navHtml = entryToUtf8(buffer, navEntry);
      } catch {
        navHtml = undefined;
      }
    }
  }

  let ncxXml: string | undefined;
  if (book.tocPath) {
    const tocEntry = entryByName.get(book.tocPath);
    if (tocEntry) {
      try {
        ncxXml = entryToUtf8(buffer, tocEntry);
      } catch {
        ncxXml = undefined;
      }
    }
  }

  return extractChaptersFromContents({
    navHtml,
    navPath: book.navPath,
    ncxXml,
    tocPath: book.tocPath,
    pagePaths: book.pagePaths,
  });
}

export async function discoverBooks(userdataRoot: string): Promise<BookInfo[]> {
  const blobRoots = detectBlobRoots(userdataRoot);
  if (!blobRoots.length) {
    return [];
  }

  const files = new Set<string>();
  for (const blobRoot of blobRoots) {
    const entries = await fs.readdir(blobRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.add(path.join(blobRoot, entry.name));
      }
    }
  }

  const sortedBlobPaths = Array.from(files).sort((left, right) => left.localeCompare(right));

  const books: BookInfo[] = [];

  for (const blobPath of sortedBlobPaths) {
    const fileName = path.basename(blobPath);
    const stat = await fs.stat(blobPath);
    if (stat.size < 1_000_000) {
      continue;
    }

    const buffer = await fs.readFile(blobPath);
    const archive = parseCustomArchive(buffer);
    const opfEntry = archive.entries.find(
      (entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(".opf"),
    );
    if (!opfEntry) {
      continue;
    }

    let metadata: BookMetadata;
    try {
      metadata = parseBookFromOpf(entryToUtf8(buffer, opfEntry), opfEntry.name);
    } catch {
      continue;
    }

    if (!metadata.pagePaths.length) {
      continue;
    }

    const firstPagePath = metadata.pagePaths[0];
    const firstPageEntry = archive.entries.find((entry) => entry.name === firstPagePath);
    let viewport = DEFAULT_VIEWPORT;
    if (firstPageEntry) {
      try {
        viewport = parseViewportFromXhtml(entryToUtf8(buffer, firstPageEntry));
      } catch {
        viewport = DEFAULT_VIEWPORT;
      }
    }

    const mediaPaths = [...metadata.mediaPaths];
    const seenMediaPaths = new Set(mediaPaths);
    for (const entry of archive.entries) {
      if (entry.isDirectory || seenMediaPaths.has(entry.name)) {
        continue;
      }
      if (isMediaPath(entry.name)) {
        seenMediaPaths.add(entry.name);
        mediaPaths.push(entry.name);
      }
    }

    books.push({
      blobPath,
      blobName: fileName,
      title: metadata.title,
      isbn: metadata.isbn,
      pagePaths: metadata.pagePaths,
      mediaPaths,
      opfPath: metadata.opfPath,
      tocPath: metadata.tocPath,
      navPath: metadata.navPath,
      viewport,
      entryCount: archive.entries.length,
      hasEncryptedTailMarker: archive.hasEncryptedTailMarker,
    });
  }

  return books;
}
