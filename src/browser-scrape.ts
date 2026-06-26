import * as path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";

import { DEFAULT_VIEWPORT, parseBookFromOpf, parseViewportFromXhtml } from "./book.js";
import { safeFileName } from "./paths.js";
import { renderRemoteBookToPdf } from "./reconstruct.js";
import type { BookInfo, ProgressUpdate, ReconstructionSummary } from "./types.js";

const RESOURCES_URL = "https://www.cambridge.org/go/resources";

export type BrowserAccountBook = {
  resourceTitle: string;
  bookTitle: string;
  readerUrl: string;
};

type BrowserScanProgress = {
  message: string;
  current: number;
  total: number;
  discovered: number;
};

type BrowserLog = (message: string) => void;

async function ignoreSlowClose(close: () => Promise<unknown>): Promise<void> {
  await Promise.race([
    close(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 3000);
    }),
  ]).catch(() => {});
}

function getEnvOrValue(value: string | undefined, envKey: string): string | undefined {
  return value ?? process.env[envKey];
}

async function connectBrowser(params: { browserPath?: string; cdpUrl?: string }) {
  if (params.cdpUrl) {
    return chromium.connectOverCDP(params.cdpUrl);
  }

  if (!params.browserPath) {
    throw new Error("Missing browser executable path.");
  }

  return chromium.launch({
    executablePath: params.browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

function getBookIdFromReaderUrl(readerUrl: string): string {
  const url = new URL(readerUrl);
  return url.searchParams.get("bookid") ?? url.hash.match(/book\/(\d+)/)?.[1] ?? "remote";
}

function getRemoteBookBaseUrl(opfUrl: string): string {
  const marker = opfUrl.match(/\/OEBPS\/(?:content|package)\.opf$/)?.[0];
  if (!marker) {
    throw new Error(`Unexpected content.opf URL: ${opfUrl}`);
  }
  return opfUrl.slice(0, -marker.length + 1);
}

async function dismissCookiesIfPresent(page: Page): Promise<void> {
  const rejectButton = page.getByRole("button", { name: /reject all/i });
  if (await rejectButton.isVisible().catch(() => false)) {
    await rejectButton.click();
  }
}

async function loginIfNeeded(params: {
  page: Page;
  email?: string;
  password?: string;
  log?: BrowserLog;
}): Promise<void> {
  const { page, email, password, log } = params;
  log?.("Checking whether Cambridge GO needs login...");
  const emailInput = page.getByLabel(/email address/i);
  const needsLogin = await emailInput
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!needsLogin) {
    log?.("Already logged in.");
    return;
  }

  if (!email || !password) {
    throw new Error(
      "Cambridge GO login required. Pass --email/--password or set CAMBRIDGE_GO_EMAIL/CAMBRIDGE_GO_PASSWORD.",
    );
  }

  log?.("Dismissing cookies if the banner is present...");
  await dismissCookiesIfPresent(page);
  log?.("Entering email...");
  await emailInput.fill(email);
  log?.("Submitting email...");
  await page.getByRole("button", { name: /^continue$/i }).click();

  const passwordInput = page.locator('input[type="password"]:visible').first();
  log?.("Waiting for password field...");
  await passwordInput.waitFor({ state: "visible" });
  log?.("Entering password...");
  await passwordInput.fill(password);
  log?.("Submitting password...");
  await page.getByRole("button", { name: /^continue$/i }).click();
}

async function waitForViewerFrame(page: Page): Promise<Frame> {
  const existingFrame = page
    .frames()
    .find((frame) => frame.url().includes("/Reader_GO/viewer.html"));
  if (existingFrame) {
    return existingFrame;
  }

  return page.waitForEvent("framenavigated", {
    predicate: (frame: Frame) => frame.url().includes("/Reader_GO/viewer.html"),
    timeout: 60000,
  });
}

function cleanButtonText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/opens in a new tab$/i, "")
    .replace(/coming soon$/i, "")
    .trim();
}

function resourceSlug(title: string): string {
  return title
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function getReaderUrlFromBookButton(
  page: Page,
  bookButton: Locator,
): Promise<string | undefined> {
  const staticUrl = await bookButton
    .evaluate((element) => {
      const link = element.closest("a[href]") ?? element.querySelector("a[href]");
      const href = link?.getAttribute("href") ?? element.getAttribute("href");
      if (href) {
        return new URL(href, window.location.href).href;
      }

      const match = element.outerHTML.match(
        /(?:https?:\/\/www\.cambridge\.org)?\/go\/ereader\/read\/[^"'\s<>]+/,
      );
      const matchedUrl = match?.[0]?.replace(/&amp;/g, "&");
      return matchedUrl ? new URL(matchedUrl, window.location.href).href : undefined;
    })
    .catch(() => undefined);

  if (staticUrl) {
    return staticUrl;
  }

  const popupPromise = page.waitForEvent("popup", { timeout: 30000 }).catch(() => undefined);
  await bookButton.click().catch(() => {});
  const popup = await popupPromise;
  if (!popup) {
    return undefined;
  }

  await popup
    .waitForURL((url) => url.href.includes("/go/ereader/read/"), { timeout: 30000 })
    .catch(() => {});
  const popupUrl = popup.url();
  await popup.close().catch(() => {});
  return popupUrl.includes("/go/ereader/read/") ? popupUrl : undefined;
}

export async function listBrowserAccountBooks(params: {
  email?: string;
  password?: string;
  browserPath?: string;
  cdpUrl?: string;
  navigationTimeoutMs: number;
  log?: BrowserLog;
  progress?: (update: BrowserScanProgress) => void;
}): Promise<BrowserAccountBook[]> {
  const email = getEnvOrValue(params.email, "CAMBRIDGE_GO_EMAIL");
  const password = getEnvOrValue(params.password, "CAMBRIDGE_GO_PASSWORD");
  const browser = await connectBrowser({ browserPath: params.browserPath, cdpUrl: params.cdpUrl });
  const context = params.cdpUrl
    ? (browser.contexts()[0] ?? (await browser.newContext()))
    : await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(params.navigationTimeoutMs);
  let discovered = 0;
  const emitProgress = (message: string, current = 0, total = 1) => {
    params.progress?.({ message, current, total, discovered });
  };

  try {
    emitProgress("Opening Cambridge GO resources...");
    params.log?.(`Opening Cambridge GO resources: ${RESOURCES_URL}`);
    await page.goto(RESOURCES_URL, {
      waitUntil: "domcontentloaded",
      timeout: params.navigationTimeoutMs,
    });
    emitProgress("Checking Cambridge GO login...");
    await loginIfNeeded({ page, email, password, log: params.log });
    emitProgress("Waiting for resources page...");
    params.log?.("Waiting for resources page...");
    await page
      .waitForURL((url) => url.href.includes("/go/resources"), { timeout: 30000 })
      .catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});

    await page.getByRole("heading", { name: /^Resources$/i }).waitFor({ timeout: 30000 });
    await page
      .getByRole("button", { name: /click to view .* resource/i })
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => {});
    const resourceButtons = await page
      .getByRole("button", { name: /click to view .* resource/i })
      .all();
    params.log?.(`Found ${resourceButtons.length} resource button(s).`);
    const resources: Array<{ index: number; title: string }> = [];
    for (let index = 0; index < resourceButtons.length; index += 1) {
      const button = resourceButtons[index];
      if (!button) {
        continue;
      }
      const label =
        (await button.getAttribute("aria-label")) ?? (await button.innerText().catch(() => ""));
      const resourceTitle = cleanButtonText(label)
        .replace(/^Click to view /i, "")
        .replace(/ resource\.?$/i, "");
      if (label && resourceTitle) {
        resources.push({ index, title: resourceTitle });
      }
    }

    if (!resources.length) {
      const bodyText = await page.locator("body").innerText();
      const seen = new Set<string>();
      for (const line of bodyText.split("\n").map((item) => item.trim())) {
        if (!line.startsWith("Cambridge ") || seen.has(line)) {
          continue;
        }
        seen.add(line);
        resources.push({ index: resources.length, title: line });
      }
    }

    params.log?.(`Scanning ${resources.length} resource page(s)...`);
    emitProgress(
      `Scanning ${resources.length} resource page(s)...`,
      0,
      Math.max(1, resources.length),
    );
    const books: BrowserAccountBook[] = [];
    for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex += 1) {
      const resource = resources[resourceIndex];
      if (!resource) {
        continue;
      }
      emitProgress(`Opening ${resource.title}`, resourceIndex, Math.max(1, resources.length));
      params.log?.(`Opening resource: ${resource.title}`);
      await page.goto(`${RESOURCES_URL}/${resourceSlug(resource.title)}`, {
        waitUntil: "domcontentloaded",
        timeout: params.navigationTimeoutMs,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      emitProgress(`Scanning ${resource.title}`, resourceIndex, Math.max(1, resources.length));
      params.log?.(`Resource loaded: ${resource.title}`);
      const resourceTitle =
        (await page
          .getByRole("heading", { level: 1 })
          .innerText()
          .catch(() => resource.title)) || resource.title;

      await page
        .locator('[role="button"][title="Open in a new tab"]')
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
      const bookButtons = await page.locator('[role="button"][title="Open in a new tab"]').all();
      params.log?.(`Found ${bookButtons.length} card(s) in resource.`);
      for (const bookButton of bookButtons) {
        const bookTitle = cleanButtonText(await bookButton.innerText().catch(() => ""));
        if (!bookTitle || !/(digital version|expiry|days left)/i.test(bookTitle)) {
          continue;
        }

        emitProgress(`Resolving ${bookTitle}`, resourceIndex, Math.max(1, resources.length));
        params.log?.(`Resolving reader URL: ${bookTitle}`);
        const readerUrl = await getReaderUrlFromBookButton(page, bookButton);
        if (!readerUrl) {
          params.log?.(`Skipping book without reader URL: ${bookTitle}`);
          continue;
        }

        books.push({ resourceTitle, bookTitle, readerUrl });
        discovered = books.length;
        emitProgress(
          `Found ${books.length} book(s)`,
          resourceIndex + 1,
          Math.max(1, resources.length),
        );
        params.log?.(`Queued book: ${bookTitle}`);
      }

      await page.goto(RESOURCES_URL, {
        waitUntil: "domcontentloaded",
        timeout: params.navigationTimeoutMs,
      });
      await page.getByRole("heading", { name: /^Resources$/i }).waitFor({ timeout: 30000 });
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    params.log?.(`Finished account scan: ${books.length} book(s) available.`);
    emitProgress(`Finished account scan: ${books.length} book(s) available.`, 1, 1);
    return books;
  } finally {
    await ignoreSlowClose(() => page.close());
    if (!params.cdpUrl) {
      await ignoreSlowClose(() => context.close());
    }
    await ignoreSlowClose(() => browser.close());
  }
}

async function discoverRemoteBook(params: {
  readerUrl: string;
  email?: string;
  password?: string;
  browserPath?: string;
  cdpUrl?: string;
  navigationTimeoutMs: number;
  browser?: Awaited<ReturnType<typeof connectBrowser>>;
  context?: BrowserContext;
  keepReaderPage?: boolean;
  log?: BrowserLog;
}): Promise<{
  book: BookInfo;
  remoteBookBaseUrl: string;
  readerPage?: Page;
  viewerFrame?: Frame;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
}> {
  const { readerUrl, email, password, browserPath, cdpUrl, navigationTimeoutMs } = params;
  const browser = params.browser ?? (await connectBrowser({ browserPath, cdpUrl }));
  const context =
    params.context ??
    (cdpUrl ? (browser.contexts()[0] ?? (await browser.newContext())) : await browser.newContext());
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(navigationTimeoutMs);

  const opfResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/extracted_books/") &&
      /\/OEBPS\/(?:content|package)\.opf$/.test(response.url()),
    { timeout: Math.max(navigationTimeoutMs, 60000) },
  );

  try {
    params.log?.(`Navigating to reader: ${readerUrl}`);
    await page.goto(readerUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await loginIfNeeded({ page, email, password, log: params.log });
    params.log?.("Waiting for Cambridge reader frame...");
    const viewerFrame = await waitForViewerFrame(page);

    params.log?.("Waiting for book manifest...");
    const opfResponse = await opfResponsePromise;
    const opfUrl = opfResponse.url();
    const opfXml = await opfResponse.text();
    const remoteBookBaseUrl = getRemoteBookBaseUrl(opfUrl);
    const metadata = parseBookFromOpf(
      opfXml,
      new URL(opfUrl).pathname.split("/").slice(-2).join("/"),
    );
    const firstPagePath = metadata.pagePaths[0];
    let viewport = DEFAULT_VIEWPORT;

    if (firstPagePath) {
      const pageResponse = await context.request.get(
        new URL(firstPagePath, remoteBookBaseUrl).href,
      );
      if (pageResponse.ok()) {
        viewport = parseViewportFromXhtml(await pageResponse.text());
      }
    }

    return {
      remoteBookBaseUrl,
      readerPage: params.keepReaderPage ? page : undefined,
      viewerFrame,
      storageState: cdpUrl ? undefined : await context.storageState(),
      book: {
        blobPath: "",
        blobName: new URL(remoteBookBaseUrl).pathname,
        title: metadata.title,
        isbn: metadata.isbn,
        pagePaths: metadata.pagePaths,
        opfPath: metadata.opfPath,
        tocPath: metadata.tocPath,
        navPath: metadata.navPath,
        viewport,
        entryCount: metadata.pagePaths.length,
        hasEncryptedTailMarker: false,
      },
    };
  } finally {
    if (!params.keepReaderPage) {
      await ignoreSlowClose(() => page.close());
    }
    if (!params.keepReaderPage && !params.context && !cdpUrl) {
      await ignoreSlowClose(() => context.close());
    }
    if (!params.keepReaderPage && !params.browser) {
      await ignoreSlowClose(() => browser.close());
    }
  }
}

export async function runBrowserScrape(params: {
  readerUrl: string;
  progressId?: string;
  email?: string;
  password?: string;
  outDir: string;
  tempRoot: string;
  browserPath?: string;
  cdpUrl?: string;
  navigationTimeoutMs: number;
  maxPages?: number;
  emit: (update: ProgressUpdate) => void;
  log?: BrowserLog;
}): Promise<ReconstructionSummary> {
  const { readerUrl } = params;
  const progressId = params.progressId ?? readerUrl;
  const email = getEnvOrValue(params.email, "CAMBRIDGE_GO_EMAIL");
  const password = getEnvOrValue(params.password, "CAMBRIDGE_GO_PASSWORD");
  const sharedBrowser = await connectBrowser({
    browserPath: params.browserPath,
    cdpUrl: params.cdpUrl,
  });
  const sharedContext = params.cdpUrl
    ? (sharedBrowser.contexts()[0] ?? (await sharedBrowser.newContext()))
    : await sharedBrowser.newContext();

  params.log?.(`Opening reader URL: ${readerUrl}`);
  const { book, remoteBookBaseUrl, readerPage, viewerFrame, storageState } =
    await discoverRemoteBook({
      readerUrl,
      email,
      password,
      browserPath: params.browserPath,
      cdpUrl: params.cdpUrl,
      navigationTimeoutMs: params.navigationTimeoutMs,
      browser: sharedBrowser,
      context: sharedContext,
      keepReaderPage: true,
      log: params.log,
    });

  const pagePaths =
    typeof params.maxPages === "number" && params.maxPages > 0
      ? book.pagePaths.slice(0, params.maxPages)
      : book.pagePaths;
  const scopedBook: BookInfo = { ...book, pagePaths };
  const outputPdfPath = path.join(params.outDir, `${safeFileName(book.title)}.pdf`);

  params.log?.(`Discovered reader book: ${book.title} (${book.isbn})`);
  params.log?.(`Writing PDF to: ${outputPdfPath}`);

  params.emit({
    isbn: progressId,
    title: scopedBook.title,
    status: "rendering",
    completedPages: 0,
    totalPages: scopedBook.pagePaths.length,
    message: `bookid ${getBookIdFromReaderUrl(readerUrl)}`,
  });

  try {
    params.log?.(`Rendering ${scopedBook.pagePaths.length} page(s)...`);
    await renderRemoteBookToPdf({
      remoteBookBaseUrl,
      book: scopedBook,
      browserExecutablePath: params.browserPath,
      cdpUrl: params.cdpUrl,
      context: sharedContext,
      viewerFrame,
      storageState,
      outputPdfPath,
      navigationTimeoutMs: params.navigationTimeoutMs,
      tempRoot: params.tempRoot,
      onProgress: (progress) => {
        params.emit({
          isbn: progressId,
          title: scopedBook.title,
          status: progress.status,
          completedPages: progress.completedPages,
          totalPages: progress.totalPages,
        });
      },
    });

    if (readerPage) {
      await ignoreSlowClose(() => readerPage.close());
    }
    await ignoreSlowClose(() => sharedBrowser.close());

    return { succeeded: [outputPdfPath], failed: [] };
  } catch (error) {
    if (readerPage) {
      await ignoreSlowClose(() => readerPage.close());
    }
    await ignoreSlowClose(() => sharedBrowser.close());
    const message = error instanceof Error ? error.message : String(error);
    params.emit({
      isbn: progressId,
      title: scopedBook.title,
      status: "error",
      completedPages: 0,
      totalPages: scopedBook.pagePaths.length,
      message,
    });
    return {
      succeeded: [],
      failed: [{ isbn: scopedBook.isbn, title: scopedBook.title, error: message }],
    };
  }
}
