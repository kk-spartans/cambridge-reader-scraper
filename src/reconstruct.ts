import { promises as fs, existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type BrowserContext, type Frame, type Page } from "playwright-core";
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractRevision(directoryName: string, prefix: string): number {
  const value = directoryName.slice(prefix.length);
  const revision = Number(value);
  return Number.isFinite(revision) ? revision : Number.NEGATIVE_INFINITY;
}

function findExecutableOnPath(names: string[]): string | undefined {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export function detectPlaywrightBrowserExecutable(): string {
  const explicit =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    process.env.CHROMIUM_PATH ??
    process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const executableFromPath = findExecutableOnPath([
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
    "chrome",
    "msedge",
  ]);
  if (executableFromPath) {
    return executableFromPath;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "Chromium executable not found. Install Chromium, set CHROME_PATH/CHROMIUM_PATH, or pass --browser.",
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

async function launchBrowser(params: { browserExecutablePath?: string; cdpUrl?: string }) {
  if (params.cdpUrl) {
    return chromium.connectOverCDP(params.cdpUrl);
  }

  if (!params.browserExecutablePath) {
    throw new Error("Missing browser executable path.");
  }

  return chromium.launch({
    executablePath: params.browserExecutablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
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

async function waitForPageAssets(page: Page): Promise<void> {
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
}

async function detectTransientErrorPage(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    const title = document.title ?? "";
    const combined = `${title}\n${text}`;

    if (/CLOUDFLARE_ERROR_500S_BOX/i.test(combined)) {
      return "Cloudflare 5xx error page";
    }
    if (/Service Temporarily Unavailable/i.test(combined)) {
      return "service temporarily unavailable page";
    }
    if (/server is temporarily unable to service your request/i.test(combined)) {
      return "temporary server error page";
    }

    return undefined;
  });
}

function remoteAssetUrlsFromText(text: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /\b(?:src|href)=["']([^"']+)["']/gi,
    /url\((?:["']?)([^"')]+)(?:["']?)\)/gi,
    /@import\s+(?:url\()?\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rawUrl = match[1]?.trim();
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("#")) {
        continue;
      }
      urls.add(new URL(rawUrl, baseUrl).href);
    }
  }

  return [...urls];
}

function localPathForRemoteUrl(rootDir: string, remoteUrl: string): string {
  const url = new URL(remoteUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return path.join(rootDir, ...parts);
}

function getReachableAssetHost(): string {
  const explicit = process.env.CAMBRIDGE_READER_SCRAPER_ASSET_HOST;
  if (explicit) {
    return explicit;
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "172.17.0.1";
}

async function serveDirectory(rootDir: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const decodedPath = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
      const filePath = path.resolve(rootDir, decodedPath);
      const resolvedRoot = path.resolve(rootDir);

      if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const file = await fs.readFile(filePath);
      response.writeHead(200);
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to start local asset server.");
  }

  const host = getReachableAssetHost();
  return { server, baseUrl: `http://${host}:${address.port}/` };
}

async function fetchViewerAsset(frame: Frame, remoteUrl: string): Promise<Buffer> {
  const context = frame.page().context();
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const userAgent = await frame.evaluate(() => navigator.userAgent).catch(() => undefined);
  let directFetchError: string | undefined;

  try {
    const response = await context.request.get(remoteUrl, {
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        Referer: frame.url(),
      },
      timeout: 10_000,
    });
    if (response.ok()) {
      const buffer = await response.body();
      const text = buffer.subarray(0, 512).toString("utf8");
      if (/CLOUDFLARE_ERROR_500S_BOX|Service Temporarily Unavailable/i.test(text)) {
        throw new Error(`Cloudflare error page`);
      }
      return buffer;
    }

    directFetchError = `HTTP ${response.status()}`;
  } catch (error) {
    directFetchError = error instanceof Error ? firstLine(error.message) : String(error);
  }

  try {
    return await fetchViewerAssetThroughCDP(frame, remoteUrl);
  } catch (error) {
    const browserFetchError = error instanceof Error ? firstLine(error.message) : String(error);
    throw new Error(
      `Unable to fetch ${remoteUrl}: direct fetch failed (${directFetchError ?? "unknown"}); browser fetch failed (${browserFetchError})`,
    );
  }
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

async function fetchViewerAssetThroughCDP(frame: Frame, remoteUrl: string): Promise<Buffer> {
  const result = await frame.evaluate(async (url) => {
    const browserResponse = await fetch(url, { credentials: "include" });
    const text = await browserResponse
      .clone()
      .text()
      .then((t) => t.slice(0, 512));

    const blob = await browserResponse.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return {
      ok: browserResponse.ok,
      status: browserResponse.status,
      text,
      data: dataUrl.split(",", 2)[1] ?? "",
      dataLength: blob.size,
    };
  }, remoteUrl);

  if (!result.ok) {
    throw new Error(`Unable to fetch ${remoteUrl}: HTTP ${result.status}`);
  }
  if (/CLOUDFLARE_ERROR_500S_BOX|Service Temporarily Unavailable/i.test(result.text)) {
    throw new Error(`Unable to fetch ${remoteUrl}: Cloudflare error page`);
  }

  if (result.dataLength === 0) {
    throw new Error(`Fetched empty asset: ${remoteUrl}`);
  }

  return Buffer.from(result.data, "base64");
}

async function materializeRemoteBookAssets(params: {
  frame: Frame;
  remoteBookBaseUrl: string;
  book: BookInfo;
  destinationDir: string;
}): Promise<string> {
  const { frame, remoteBookBaseUrl, book, destinationDir } = params;
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  let pending = book.pagePaths.map((relativePath) => new URL(relativePath, remoteBookBaseUrl).href);
  const seen = new Set<string>();

  while (pending.length) {
    const batch = pending.filter((remoteUrl) => remoteUrl && !seen.has(remoteUrl));
    pending = [];
    for (const remoteUrl of batch) {
      seen.add(remoteUrl);
    }

    const nextAssetUrls = await mapWithConcurrency(batch, 16, async (remoteUrl) => {
      const buffer = await fetchViewerAsset(frame, remoteUrl);
      const localPath = localPathForRemoteUrl(destinationDir, remoteUrl);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, buffer);

      const pathname = new URL(remoteUrl).pathname.toLowerCase();
      if (pathname.endsWith(".xhtml") || pathname.endsWith(".html") || pathname.endsWith(".css")) {
        const text = buffer.toString("utf8");
        return remoteAssetUrlsFromText(text, remoteUrl).filter(
          (assetUrl) =>
            new URL(assetUrl).origin === new URL(remoteBookBaseUrl).origin && !seen.has(assetUrl),
        );
      }

      return [];
    });

    for (const assetUrls of nextAssetUrls) {
      for (const assetUrl of assetUrls) {
        if (!seen.has(assetUrl)) {
          pending.push(assetUrl);
        }
      }
    }
  }

  return localPathForRemoteUrl(destinationDir, remoteBookBaseUrl);
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

async function renderImageBackedBookToPdf(params: {
  materializedBookBasePath: string;
  book: BookInfo;
  outputPdfPath: string;
  onProgress?: (progress: {
    completedPages: number;
    totalPages: number;
    status: "rendering" | "processing" | "done";
  }) => void;
}): Promise<boolean> {
  const { materializedBookBasePath, book, outputPdfPath, onProgress } = params;
  const pdf = await PDFDocument.create();

  for (let index = 0; index < book.pagePaths.length; index += 1) {
    const pagePath = book.pagePaths[index];
    if (!pagePath) {
      continue;
    }

    const xhtmlPath = path.join(materializedBookBasePath, ...pagePath.split("/"));
    const xhtml = await fs.readFile(xhtmlPath, "utf8").catch(() => undefined);
    if (!xhtml) {
      return false;
    }

    const cssHref = firstMatch(xhtml, /<link[^>]+href=["']([^"']+\.css)["']/i);
    if (!cssHref) {
      return false;
    }

    const cssPath = path.resolve(path.dirname(xhtmlPath), cssHref);
    const css = await fs.readFile(cssPath, "utf8").catch(() => undefined);
    if (!css) {
      return false;
    }

    const imageHref = firstMatch(css, /background-image:\s*url\(["']?([^"')]+)["']?\)/i);
    if (!imageHref) {
      return false;
    }

    const imagePath = path.resolve(path.dirname(cssPath), imageHref);
    const imageBytes = await fs.readFile(imagePath).catch(() => undefined);
    if (!imageBytes) {
      return false;
    }

    const lowerImagePath = imagePath.toLowerCase();
    const image = lowerImagePath.endsWith(".png")
      ? await pdf.embedPng(imageBytes)
      : await pdf.embedJpg(imageBytes);
    const page = pdf.addPage([book.viewport.width, book.viewport.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: book.viewport.width,
      height: book.viewport.height,
    });

    onProgress?.({
      completedPages: index + 1,
      totalPages: book.pagePaths.length,
      status: "rendering",
    });
  }

  onProgress?.({
    completedPages: book.pagePaths.length,
    totalPages: book.pagePaths.length,
    status: "processing",
  });

  pdf.setTitle(book.title);
  pdf.setAuthor("Cambridge Reader");
  pdf.setSubject(`ISBN ${book.isbn}`);
  await fs.writeFile(outputPdfPath, await pdf.save());

  onProgress?.({
    completedPages: book.pagePaths.length,
    totalPages: book.pagePaths.length,
    status: "done",
  });
  return true;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await mapper(item);
        }
      }
    }),
  );

  return results;
}

async function navigateToRenderablePage(params: {
  page: Page;
  url: string;
  timeout: number;
  label: string;
}): Promise<void> {
  const retryDelays = [2_000, 5_000, 10_000, 20_000, 30_000];
  let lastError = "navigation failed";

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const response = await params.page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeout: params.timeout,
    });

    const status = response?.status();
    if (status && status >= 500) {
      lastError = `HTTP ${status}`;
    } else {
      const transientError = await detectTransientErrorPage(params.page);
      if (!transientError) {
        return;
      }
      lastError = transientError;
    }

    const delay = retryDelays[attempt];
    if (delay === undefined) {
      break;
    }

    await wait(delay);
  }

  throw new Error(`Unable to render ${params.label}: ${lastError}`);
}

async function renderBookToPdf(params: {
  extractedBookDir: string;
  book: BookInfo;
  browserExecutablePath: string;
  cdpUrl?: string;
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
    cdpUrl,
    outputPdfPath,
    navigationTimeoutMs,
    onProgress,
  } = params;

  if (!book.pagePaths.length) {
    throw new Error("No printable pages detected for this book.");
  }

  const browser = await launchBrowser({ browserExecutablePath, cdpUrl });

  const context = cdpUrl
    ? (browser.contexts()[0] ??
      (await browser.newContext({
        viewport: { width: book.viewport.width, height: book.viewport.height },
      })))
    : await browser.newContext({
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

      await waitForPageAssets(page);

      const pageSize = book.viewport;

      const partialPath = path.join(tempPdfDir, `${String(index + 1).padStart(5, "0")}.pdf`);
      await page.emulateMedia({ media: "print" });
      await page.pdf({
        path: partialPath,
        printBackground: true,
        preferCSSPageSize: false,
        width: `${pageSize.width}px`,
        height: `${pageSize.height}px`,
        tagged: false,
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
    if (!cdpUrl) {
      await context.close();
    }
    await browser.close();
  }
}

export async function renderRemoteBookToPdf(params: {
  remoteBookBaseUrl: string;
  book: BookInfo;
  browserExecutablePath?: string;
  cdpUrl?: string;
  context?: BrowserContext;
  viewerFrame?: Frame;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
  outputPdfPath: string;
  navigationTimeoutMs: number;
  tempRoot: string;
  onProgress?: (progress: {
    completedPages: number;
    totalPages: number;
    status: "rendering" | "processing" | "done";
  }) => void;
}): Promise<void> {
  const {
    remoteBookBaseUrl,
    book,
    browserExecutablePath,
    cdpUrl,
    context: providedContext,
    viewerFrame,
    storageState,
    outputPdfPath,
    navigationTimeoutMs,
    tempRoot,
    onProgress,
  } = params;

  if (!book.pagePaths.length) {
    throw new Error("No printable pages detected for this book.");
  }

  const browser = providedContext
    ? undefined
    : await launchBrowser({ browserExecutablePath, cdpUrl });

  const context =
    providedContext ??
    (cdpUrl
      ? (browser?.contexts()[0] ??
        (await browser?.newContext({
          storageState,
          viewport: { width: book.viewport.width, height: book.viewport.height },
        })))
      : await browser?.newContext({
          storageState,
          viewport: { width: book.viewport.width, height: book.viewport.height },
        }));

  if (!context) {
    throw new Error("Unable to create browser context.");
  }

  await fs.mkdir(path.dirname(outputPdfPath), { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const partialPdfPaths: string[] = [];
  const tempPdfDir = path.join(tempRoot, `${book.isbn}_remote_page_pdfs`);
  const materializedAssetRoot = path.join(tempRoot, `${book.isbn}_remote_assets`);
  const materializedBookBasePath = viewerFrame
    ? await materializeRemoteBookAssets({
        frame: viewerFrame,
        remoteBookBaseUrl,
        book,
        destinationDir: materializedAssetRoot,
      })
    : undefined;
  let assetServer: Awaited<ReturnType<typeof serveDirectory>> | undefined;
  await fs.rm(tempPdfDir, { recursive: true, force: true });
  await fs.mkdir(tempPdfDir, { recursive: true });

  try {
    if (
      materializedBookBasePath &&
      (await renderImageBackedBookToPdf({
        materializedBookBasePath,
        book,
        outputPdfPath,
        onProgress,
      }))
    ) {
      return;
    }

    assetServer = viewerFrame ? await serveDirectory(materializedAssetRoot) : undefined;

    onProgress?.({
      completedPages: 0,
      totalPages: book.pagePaths.length,
      status: "rendering",
    });

    let completedPages = 0;
    const renderedPaths = await mapWithConcurrency(
      book.pagePaths.map((relativePagePath, index) => ({ relativePagePath, index })),
      Math.min(4, Math.max(1, book.pagePaths.length)),
      async ({ relativePagePath, index }) => {
        if (!relativePagePath) {
          return undefined;
        }

        const renderPage = await context.newPage();
        renderPage.setDefaultNavigationTimeout(navigationTimeoutMs);

        try {
          const localPagePath = materializedBookBasePath
            ? path.join(materializedBookBasePath, ...relativePagePath.split("/"))
            : undefined;
          const pageUrl = localPagePath
            ? new URL(
                path.relative(materializedAssetRoot, localPagePath).split(path.sep).join("/"),
                assetServer?.baseUrl,
              ).href
            : new URL(relativePagePath, remoteBookBaseUrl).href;

          await navigateToRenderablePage({
            page: renderPage,
            url: pageUrl,
            timeout: navigationTimeoutMs,
            label: `page ${index + 1}`,
          });

          await waitForPageAssets(renderPage);

          const partialPath = path.join(tempPdfDir, `${String(index + 1).padStart(5, "0")}.pdf`);
          await renderPage.emulateMedia({ media: "print" });
          await renderPage.pdf({
            path: partialPath,
            printBackground: true,
            preferCSSPageSize: false,
            width: `${book.viewport.width}px`,
            height: `${book.viewport.height}px`,
            tagged: false,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            pageRanges: "1",
          });

          completedPages += 1;
          onProgress?.({
            completedPages,
            totalPages: book.pagePaths.length,
            status: "rendering",
          });

          return partialPath;
        } finally {
          await renderPage.close().catch(() => {});
        }
      },
    );

    partialPdfPaths.push(...renderedPaths.filter((item): item is string => Boolean(item)));

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

    const finalizedPdfBytes = await renderedPdf.save();
    await fs.writeFile(outputPdfPath, finalizedPdfBytes);

    onProgress?.({
      completedPages: book.pagePaths.length,
      totalPages: book.pagePaths.length,
      status: "done",
    });
  } finally {
    await new Promise<void>((resolve) => assetServer?.server.close(() => resolve()) ?? resolve());
    await fs.rm(tempPdfDir, { recursive: true, force: true });
    if (!providedContext && !cdpUrl) {
      await context.close();
    }
    await browser?.close();
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
