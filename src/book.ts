import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { entryToUtf8, parseCustomArchive } from "./archive.js";
import type { BookInfo, BookMetadata, ChapterNode } from "./types.js";

const DEFAULT_VIEWPORT = { width: 957, height: 1199 };
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

function parseViewportFromXhtml(xhtml: string): { width: number; height: number } {
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

function parseBookFromOpf(opfXml: string, opfPath: string): BookMetadata {
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

  return { title, isbn, opfPath, pagePaths, tocPath, navPath };
}

function parseHtmlTocDocument(
  html: string,
  tocPath: string,
  pageIndexByPath: Map<string, number>,
): ChapterNode[] {
  const opfDir = path.posix.dirname(tocPath);

  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
  const navMarkup = navMatch?.[1] ?? html;

  const listMatch = navMarkup.match(/<ol[^>]*>([\s\S]*?)<\/ol>/i);
  const root = listMatch?.[1] ?? navMarkup;

  const items: ChapterNode[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null = liRegex.exec(root);

  while (liMatch) {
    const content = liMatch[1] ?? "";
    const anchorMatch = content.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (anchorMatch?.[1]) {
      const rawHref = anchorMatch[1];
      const hrefNoHash = rawHref.split("#")[0] ?? rawHref;
      const normalizedHref = path.posix.normalize(path.posix.join(opfDir, hrefNoHash));
      const title = (anchorMatch[2] ?? "").replace(/<[^>]+>/g, "").trim();

      items.push({
        title: title || hrefNoHash,
        href: normalizedHref,
        pageIndex: pageIndexByPath.get(normalizedHref),
        children: [],
      });
    }

    liMatch = liRegex.exec(root);
  }

  return items;
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

export function extractChaptersFromArchive(buffer: Buffer, book: BookInfo): ChapterNode[] {
  const archive = parseCustomArchive(buffer);
  const entryByName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  const pageIndexByPath = new Map<string, number>();
  for (let index = 0; index < book.pagePaths.length; index += 1) {
    const pagePath = book.pagePaths[index];
    if (pagePath) {
      pageIndexByPath.set(pagePath, index + 1);
    }
  }

  if (book.navPath) {
    const navEntry = entryByName.get(book.navPath);
    if (navEntry) {
      try {
        const html = entryToUtf8(buffer, navEntry);
        const chapters = parseHtmlTocDocument(html, book.navPath, pageIndexByPath);
        if (chapters.length) {
          return chapters;
        }
      } catch {
        // ignore and try ncx
      }
    }
  }

  if (book.tocPath) {
    const tocEntry = entryByName.get(book.tocPath);
    if (tocEntry) {
      try {
        const ncx = entryToUtf8(buffer, tocEntry);
        const parsed = XML.parse(ncx) as Record<string, unknown>;
        const ncxRoot = parsed.ncx as Record<string, unknown>;
        const navMap = (ncxRoot?.navMap ?? {}) as Record<string, unknown>;
        const navPoints = asArray(navMap.navPoint).map((item) => item as Record<string, unknown>);
        const tocDir = path.posix.dirname(book.tocPath);
        return navPoints.map((node) => parseNcxNode(node, tocDir, pageIndexByPath));
      } catch {
        return [];
      }
    }
  }

  return [];
}

export async function discoverBooks(userdataRoot: string): Promise<BookInfo[]> {
  const blobRoot = path.join(userdataRoot, "Default", "File System", "000", "p", "00");
  if (!existsSync(blobRoot)) {
    return [];
  }

  const entries = await fs.readdir(blobRoot, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const books: BookInfo[] = [];

  for (const fileName of files) {
    const blobPath = path.join(blobRoot, fileName);
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

    books.push({
      blobPath,
      blobName: fileName,
      title: metadata.title,
      isbn: metadata.isbn,
      pagePaths: metadata.pagePaths,
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
