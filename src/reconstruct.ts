import { promises as fs, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";

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

async function extractBookBlob(book: BookInfo, destinationDir: string): Promise<void> {
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

function buildChapterKeywords(chapters: ChapterNode[]): string[] {
  return flattenChapterNodes(chapters)
    .map((node) => node.title.trim())
    .filter(Boolean)
    .slice(0, 80);
}

async function renderBookToPdf(params: {
  extractedBookDir: string;
  book: BookInfo;
  browserExecutablePath: string;
  outputPdfPath: string;
  navigationTimeoutMs: number;
  onProgress?: (progress: {
    completedPages: number;
    totalPages: number;
    status: "rendering" | "processing" | "done";
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
  const partialPdfPaths: string[] = [];
  const tempPdfDir = path.join(extractedBookDir, "_page_pdfs");
  await fs.rm(tempPdfDir, { recursive: true, force: true });
  await fs.mkdir(tempPdfDir, { recursive: true });

  try {
    onProgress?.({
      completedPages: 0,
      totalPages: book.pagePaths.length,
      status: "rendering",
    });

    for (let index = 0; index < book.pagePaths.length; index += 1) {
      const relativePagePath = book.pagePaths[index];
      if (!relativePagePath) {
        continue;
      }

      const absolutePagePath = path.join(extractedBookDir, ...relativePagePath.split("/"));
      await page.goto(pathToFileURL(absolutePagePath).href, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });

      await page.evaluate(`
        (async () => {
          const wait = (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, ms);
            });

          const docRef = globalThis.document;
          const fonts = docRef?.fonts;
          if (fonts?.ready) {
            await Promise.race([fonts.ready, wait(4000)]);
          }

          const imagePromises = Array.from(docRef?.images ?? []).map((image) => {
            if (image.complete) {
              return Promise.resolve();
            }
            return Promise.race([
              new Promise((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              }),
              wait(2500),
            ]);
          });

          await Promise.allSettled(imagePromises);
        })();
      `);

      const partialPath = path.join(tempPdfDir, `${String(index + 1).padStart(5, "0")}.pdf`);
      await page.emulateMedia({ media: "print" });
      await page.pdf({
        path: partialPath,
        printBackground: true,
        preferCSSPageSize: true,
        width: `${book.viewport.width}px`,
        height: `${book.viewport.height}px`,
        tagged: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        pageRanges: "1",
      });

      partialPdfPaths.push(partialPath);
      onProgress?.({
        completedPages: partialPdfPaths.length,
        totalPages: book.pagePaths.length,
        status: "rendering",
      });
    }

    onProgress?.({
      completedPages: book.pagePaths.length,
      totalPages: book.pagePaths.length,
      status: "processing",
    });

    const renderedPdf = await PDFDocument.create();
    for (const partialPath of partialPdfPaths) {
      const partialBytes = await fs.readFile(partialPath);
      const partialDoc = await PDFDocument.load(partialBytes);
      const copiedPages = await renderedPdf.copyPages(partialDoc, partialDoc.getPageIndices());
      for (const copiedPage of copiedPages) {
        renderedPdf.addPage(copiedPage);
      }
    }

    renderedPdf.setTitle(book.title);
    renderedPdf.setAuthor("Cambridge Reader");
    renderedPdf.setSubject(`ISBN ${book.isbn}`);

    const chapterKeywords = buildChapterKeywords(chapters);
    if (chapterKeywords.length) {
      renderedPdf.setKeywords(chapterKeywords);
    }

    const finalizedPdfBytes = await renderedPdf.save();
    await fs.writeFile(outputPdfPath, finalizedPdfBytes);

    onProgress?.({
      completedPages: book.pagePaths.length,
      totalPages: book.pagePaths.length,
      status: "done",
    });
  } finally {
    await fs.rm(tempPdfDir, { recursive: true, force: true });
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
