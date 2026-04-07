import { promises as fs, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

import { extractEntryBuffer, normalizeArchiveRelativePath, parseCustomArchive } from "./archive.js";
import { extractChaptersFromArchive } from "./book.js";
import { safeFileName } from "./paths.js";
import type {
  BookInfo,
  BookRunFailure,
  BookRunResult,
  ChapterNode,
  ProgressUpdate,
  ReconstructionSummary,
} from "./types.js";

function extractRevision(directoryName: string, prefix: string): number {
  const value = directoryName.slice(prefix.length);
  const revision = Number(value);
  return Number.isFinite(revision) ? revision : Number.NEGATIVE_INFINITY;
}

export function detectPlaywrightBrowserExecutable(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "LOCALAPPDATA is unavailable. Pass --browser to a Playwright Chromium executable.",
    );
  }

  const playwrightCacheRoot = path.join(localAppData, "ms-playwright");
  if (!existsSync(playwrightCacheRoot)) {
    throw new Error(
      "Playwright browser cache not found. Install Chromium with `pnpm exec playwright install chromium` or pass --browser.",
    );
  }

  const browserDirectories = readdirSync(playwrightCacheRoot, {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());

  const chromiumDirs = browserDirectories
    .filter((entry) => entry.name.startsWith("chromium-"))
    .sort(
      (left, right) =>
        extractRevision(right.name, "chromium-") - extractRevision(left.name, "chromium-"),
    );

  for (const directory of chromiumDirs) {
    const candidates = [
      path.join(playwrightCacheRoot, directory.name, "chrome-win", "chrome.exe"),
      path.join(playwrightCacheRoot, directory.name, "chrome-win64", "chrome.exe"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const headlessDirs = browserDirectories
    .filter((entry) => entry.name.startsWith("chromium_headless_shell-"))
    .sort(
      (left, right) =>
        extractRevision(right.name, "chromium_headless_shell-") -
        extractRevision(left.name, "chromium_headless_shell-"),
    );

  for (const directory of headlessDirs) {
    const candidates = [
      path.join(playwrightCacheRoot, directory.name, "chrome-win", "headless_shell.exe"),
      path.join(
        playwrightCacheRoot,
        directory.name,
        "chrome-headless-shell-win64",
        "chrome-headless-shell.exe",
      ),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Playwright Chromium executable not found in ms-playwright cache. Install Chromium with `pnpm exec playwright install chromium` or pass --browser.",
  );
}

export async function extractBookBlob(book: BookInfo, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  const buffer = await fs.readFile(book.blobPath);
  const archive = parseCustomArchive(buffer);

  for (const entry of archive.entries) {
    const relative = normalizeArchiveRelativePath(entry.name);
    const target = path.join(destinationDir, ...relative.split("/"));

    if (entry.isDirectory) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, extractEntryBuffer(buffer, entry));
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizePageHref(href: string): string {
  const beforeHash = href.split("#")[0] ?? href;
  return beforeHash.replaceAll("\\", "/");
}

function flattenChapterNodes(
  nodes: ChapterNode[],
  depth = 0,
): Array<{ title: string; page?: number; depth: number }> {
  const out: Array<{ title: string; page?: number; depth: number }> = [];

  for (const node of nodes) {
    out.push({
      title: node.title,
      page: node.pageIndex,
      depth,
    });
    out.push(...flattenChapterNodes(node.children, depth + 1));
  }

  return out;
}

function chapterPageByPath(chapters: ChapterNode[]): Map<string, number> {
  const map = new Map<string, number>();

  const walk = (nodes: ChapterNode[]) => {
    for (const node of nodes) {
      if (node.href && node.pageIndex) {
        map.set(normalizePageHref(node.href), node.pageIndex);
      }
      walk(node.children);
    }
  };

  walk(chapters);
  return map;
}

function buildPrintBundleHtml(params: {
  book: BookInfo;
  chapters: ChapterNode[];
  chapterPageMap: Map<string, number>;
}): string {
  const { book, chapters, chapterPageMap } = params;

  const chapterRows = flattenChapterNodes(chapters)
    .map((row) => {
      const indent = row.depth * 18;
      const page = row.page ? `<span class="toc-page">${row.page}</span>` : "";
      return `<li style="padding-left:${indent}px"><span>${escapeHtml(row.title)}</span>${page}</li>`;
    })
    .join("\n");

  const chapterIntro = chapterRows
    ? `<section class="frontmatter"><h2>Contents</h2><ol class="toc-list">${chapterRows}</ol></section>`
    : "";

  const pageSections = book.pagePaths
    .map((relativePath, index) => {
      const normalizedPath = normalizePageHref(relativePath);
      const labelPage = chapterPageMap.get(normalizedPath);
      const chapterBadge = labelPage
        ? `<div class="chapter-badge">Chapter starts p.${labelPage}</div>`
        : "";
      return `<section class="page" data-page="${index + 1}">${chapterBadge}<iframe src="${escapeHtml(relativePath)}" loading="eager"></iframe></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(book.title)}</title>
    <style>
      @page { margin: 0; size: ${book.viewport.width}px ${book.viewport.height}px; }
      html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: "Times New Roman", serif; }
      .frontmatter { page-break-after: always; min-height: ${book.viewport.height}px; box-sizing: border-box; padding: 48px; }
      .frontmatter h1 { margin: 0 0 8px; font-size: 34px; }
      .frontmatter h2 { margin: 18px 0 12px; font-size: 24px; }
      .frontmatter p { margin: 4px 0; font-size: 14px; color: #333; }
      .toc-list { margin: 0; padding: 0; list-style: none; }
      .toc-list li { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0; font-size: 13px; }
      .toc-page { color: #5a5a5a; min-width: 26px; text-align: right; }
      .page { position: relative; width: ${book.viewport.width}px; height: ${book.viewport.height}px; page-break-after: always; overflow: hidden; }
      .page iframe { width: 100%; height: 100%; border: 0; display: block; }
      .chapter-badge { position: absolute; right: 10px; top: 10px; z-index: 10; background: rgba(255,255,255,.9); border: 1px solid #ddd; border-radius: 999px; padding: 2px 8px; font-size: 11px; color: #444; }
    </style>
  </head>
  <body>
    <section class="frontmatter">
      <h1>${escapeHtml(book.title)}</h1>
      <p>ISBN: ${escapeHtml(book.isbn)}</p>
      <p>Pages: ${book.pagePaths.length}</p>
    </section>
    ${chapterIntro}
    ${pageSections}
  </body>
</html>`;
}

export async function renderBookToPdf(params: {
  extractedBookDir: string;
  book: BookInfo;
  browserExecutablePath: string;
  outputPdfPath: string;
  navigationTimeoutMs: number;
  onProgress?: (progress: {
    completedPages: number;
    totalPages: number;
    status: "rendering" | "done";
  }) => void;
}): Promise<void> {
  const {
    extractedBookDir,
    book,
    browserExecutablePath,
    outputPdfPath,
    navigationTimeoutMs,
    onProgress,
  } = params;

  if (!book.pagePaths.length) {
    throw new Error("No printable pages detected for this book.");
  }

  const browser = await chromium.launch({
    executablePath: browserExecutablePath,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: book.viewport.width, height: book.viewport.height },
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(navigationTimeoutMs);

  await fs.mkdir(path.dirname(outputPdfPath), { recursive: true });

  const bookBlobBuffer = await fs.readFile(book.blobPath);
  const chapters = extractChaptersFromArchive(bookBlobBuffer, book);
  const chapterPageMap = chapterPageByPath(chapters);
  const printBundleHtml = buildPrintBundleHtml({
    book,
    chapters,
    chapterPageMap,
  });
  const printBundlePath = path.join(extractedBookDir, "_print_bundle.html");
  await fs.writeFile(printBundlePath, printBundleHtml, "utf8");

  try {
    onProgress?.({
      completedPages: 0,
      totalPages: book.pagePaths.length,
      status: "rendering",
    });

    await page.goto(pathToFileURL(printBundlePath).href, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    });

    await page.emulateMedia({ media: "print" });

    await page.evaluate(`
      (async () => {
        const wait = (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          });

        const iframes = Array.from(document.querySelectorAll("iframe"));
        for (let index = 0; index < iframes.length; index += 1) {
          const iframe = iframes[index];
          if (!iframe) {
            continue;
          }

          await Promise.race([
            new Promise((resolve) => {
              iframe.addEventListener("load", () => resolve(), { once: true });
              iframe.addEventListener("error", () => resolve(), { once: true });
            }),
            wait(2500),
          ]);
        }
      })();
    `);

    onProgress?.({
      completedPages: Math.max(1, Math.floor(book.pagePaths.length / 2)),
      totalPages: book.pagePaths.length,
      status: "rendering",
    });

    await page.pdf({
      path: outputPdfPath,
      printBackground: true,
      preferCSSPageSize: true,
      outline: true,
      tagged: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    onProgress?.({
      completedPages: book.pagePaths.length,
      totalPages: book.pagePaths.length,
      status: "done",
    });
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) {
    return;
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}

export async function runReconstruction(params: {
  books: BookInfo[];
  outDir: string;
  tempRoot: string;
  browserPath: string;
  navigationTimeoutMs: number;
  keepExtracted: boolean;
  concurrency: number;
  maxPages?: number;
  emit: (update: ProgressUpdate) => void;
}): Promise<ReconstructionSummary> {
  const {
    books,
    outDir,
    tempRoot,
    browserPath,
    navigationTimeoutMs,
    keepExtracted,
    concurrency,
    maxPages,
    emit,
  } = params;

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const successes: BookRunResult[] = [];
  const failures: BookRunFailure[] = [];

  await runWithConcurrency(books, concurrency, async (book) => {
    const extractedDir = path.join(tempRoot, book.isbn);
    const pagePaths =
      typeof maxPages === "number" && maxPages > 0
        ? book.pagePaths.slice(0, maxPages)
        : book.pagePaths;
    const effectivePageTotal = pagePaths.length;

    emit({
      isbn: book.isbn,
      title: book.title,
      status: "extracting",
      completedPages: 0,
      totalPages: effectivePageTotal,
    });

    try {
      const scopedBook: BookInfo = {
        ...book,
        pagePaths,
      };

      await extractBookBlob(scopedBook, extractedDir);

      emit({
        isbn: book.isbn,
        title: book.title,
        status: "rendering",
        completedPages: 0,
        totalPages: effectivePageTotal,
      });

      const outputPdfPath = path.join(outDir, `${safeFileName(book.title)}.pdf`);
      await renderBookToPdf({
        extractedBookDir: extractedDir,
        book: scopedBook,
        browserExecutablePath: browserPath,
        outputPdfPath,
        navigationTimeoutMs,
        onProgress: (progress) => {
          emit({
            isbn: book.isbn,
            title: book.title,
            status: progress.status,
            completedPages: progress.completedPages,
            totalPages: progress.totalPages,
          });
        },
      });

      successes.push({
        isbn: book.isbn,
        title: book.title,
        outputPdfPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        isbn: book.isbn,
        title: book.title,
        error: message,
      });

      emit({
        isbn: book.isbn,
        title: book.title,
        status: "error",
        completedPages: 0,
        totalPages: effectivePageTotal,
        message,
      });
    } finally {
      if (!keepExtracted) {
        await fs.rm(extractedDir, { recursive: true, force: true });
      }
    }
  });

  return {
    succeeded: successes.map((item) => item.outputPdfPath),
    failed: failures,
  };
}
