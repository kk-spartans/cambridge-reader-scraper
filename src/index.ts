import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  listBrowserAccountBooks,
  runBrowserScrape,
  type BrowserAccountBook,
} from "./browser-scrape.js";
import { discoverBooks } from "./book.js";
import {
  getPositiveIntegerArg,
  getStringArg,
  getStringListArg,
  hasFlag,
  parseArgs,
} from "./cli.js";
import { CLI_NAME, isCompletionShell, renderCompletion, renderHelp } from "./meta.js";
import { resolveUserdataPath } from "./paths.js";
import { detectPlaywrightBrowserExecutable, runReconstruction } from "./reconstruct.js";
import {
  promptOutputDirectoryWithInk,
  runWithInkProgress,
  runWithInkTask,
  selectBooksWithInk,
} from "./tui.js";
import type { BookInfo, CliArgs, ProgressUpdate, ReconstructionSummary, UiBook } from "./types.js";

async function runInspectCommand(books: BookInfo[], userdataRoot: string): Promise<void> {
  if (!books.length) {
    console.log(`No downloadable book blobs detected in: ${userdataRoot}`);
    return;
  }

  console.log(`Detected ${books.length} book blob(s) in ${userdataRoot}:`);
  for (const book of books) {
    console.log("");
    console.log(`- ISBN: ${book.isbn}`);
    console.log(`  Title: ${book.title}`);
    console.log(`  Blob: ${book.blobName} (${book.blobPath})`);
    console.log(`  Entries: ${book.entryCount}`);
    console.log(`  Spine pages: ${book.pagePaths.length}`);
    console.log(`  Viewport: ${book.viewport.width}x${book.viewport.height}`);
    console.log(`  Encrypted tail marker: ${book.hasEncryptedTailMarker ? "yes" : "no"}`);
  }
}

function toUiBooks(books: BookInfo[]): UiBook[] {
  return books.map((book) => ({
    isbn: book.isbn,
    title: book.title,
    pageCount: book.pagePaths.length,
    viewportWidth: book.viewport.width,
    viewportHeight: book.viewport.height,
    entryCount: book.entryCount,
    blobName: book.blobName,
  }));
}

function browserBooksToUiBooks(books: BrowserAccountBook[]): UiBook[] {
  return books.map((book) => ({
    isbn: book.readerUrl,
    title: book.bookTitle,
    pageCount: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    entryCount: 0,
    blobName: book.resourceTitle,
  }));
}

async function selectBrowserBooks(
  args: CliArgs,
  books: BrowserAccountBook[],
): Promise<BrowserAccountBook[]> {
  if (hasFlag(args, "no-tui") || !process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(`No TUI available; selecting all ${books.length} book(s).`);
    return books;
  }

  const selectedReaderUrls = await selectBooksWithInk(browserBooksToUiBooks(books));
  if (!selectedReaderUrls.length) {
    throw new Error("No books selected.");
  }

  const selectedSet = new Set(selectedReaderUrls);
  return books.filter((book) => selectedSet.has(book.readerUrl));
}

async function selectBooks(args: CliArgs, books: BookInfo[]): Promise<BookInfo[]> {
  const requestedIsbns = new Set(getStringListArg(args, "isbn"));
  if (requestedIsbns.size > 0) {
    const selected = books.filter((book) => requestedIsbns.has(book.isbn));
    if (!selected.length) {
      throw new Error(
        `No books matched requested ISBN(s): ${Array.from(requestedIsbns).join(", ")}`,
      );
    }
    return selected;
  }

  const noTui = hasFlag(args, "no-tui");
  if (noTui || !process.stdout.isTTY || !process.stdin.isTTY) {
    return books;
  }

  const selectedIsbns = await selectBooksWithInk(toUiBooks(books));
  if (!selectedIsbns.length) {
    throw new Error("No books selected.");
  }

  const selectedSet = new Set(selectedIsbns);
  return books.filter((book) => selectedSet.has(book.isbn));
}

async function runReconstructCommand(args: CliArgs, books: BookInfo[]): Promise<void> {
  if (!books.length) {
    throw new Error("No books found to reconstruct.");
  }

  const outDir = await resolveOutputDirectory(args);
  const tempRoot = path.resolve(
    getStringArg(args, "workdir", path.join(outDir, "_extracted")) ??
      path.join(outDir, "_extracted"),
  );
  const requestedBrowserPath = getStringArg(args, "browser");
  const browserPath = path.resolve(requestedBrowserPath ?? detectPlaywrightBrowserExecutable());
  const navigationTimeoutMs = getPositiveIntegerArg(args, "page-timeout-ms", 20000);
  const maxPages = getPositiveIntegerArg(args, "max-pages", 0) || undefined;
  const keepExtracted = hasFlag(args, "keep-extracted");
  const concurrency = getPositiveIntegerArg(args, "concurrency", 1);

  const selectedBooks = await selectBooks(args, books);
  const uiBooks = toUiBooks(selectedBooks);
  const disableProgressTui =
    hasFlag(args, "no-tui") || !process.stdout.isTTY || !process.stdin.isTTY;

  const summary = disableProgressTui
    ? await runReconstruction({
        books: selectedBooks,
        outDir,
        tempRoot,
        browserPath,
        navigationTimeoutMs,
        keepExtracted,
        concurrency,
        maxPages,
        emit: () => {},
      })
    : await runWithInkProgress({
        books: uiBooks,
        run: (emit) =>
          runReconstruction({
            books: selectedBooks,
            outDir,
            tempRoot,
            browserPath,
            navigationTimeoutMs,
            keepExtracted,
            concurrency,
            maxPages,
            emit,
          }),
      });

  if (summary.succeeded.length) {
    console.log("\nGenerated PDFs:");
    for (const filePath of summary.succeeded) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.failed.length) {
    console.log("\nFailed books:");
    for (const failure of summary.failed) {
      console.log(`- ${failure.title} (${failure.isbn}): ${failure.error}`);
    }
    throw new Error(`Reconstruction completed with ${summary.failed.length} failure(s).`);
  }
}

async function runBrowserScrapeCommand(args: CliArgs): Promise<void> {
  const outDir = await resolveOutputDirectory(args);
  const tempRoot = path.resolve(
    getStringArg(args, "workdir", path.join(outDir, "_browser_scrape")) ??
      path.join(outDir, "_browser_scrape"),
  );
  const cdpUrl = getStringArg(args, "cdp-url") ?? process.env.CLOAKBROWSER_CDP_URL;
  const requestedBrowserPath = getStringArg(args, "browser");
  const browserPath = cdpUrl
    ? requestedBrowserPath
    : path.resolve(requestedBrowserPath ?? detectPlaywrightBrowserExecutable());
  const navigationTimeoutMs = getPositiveIntegerArg(args, "page-timeout-ms", 30000);
  const maxPages = getPositiveIntegerArg(args, "max-pages", 0) || undefined;
  const readerUrl = getStringArg(args, "url");
  const email = getStringArg(args, "email");
  const password = getStringArg(args, "password");
  const disableProgressTui =
    hasFlag(args, "no-tui") || !process.stdout.isTTY || !process.stdin.isTTY;
  const scanBrowserBooks = () =>
    listBrowserAccountBooks({
      email,
      password,
      browserPath,
      cdpUrl,
      navigationTimeoutMs,
      log: disableProgressTui ? (message) => console.log(message) : undefined,
    });

  const selectedBooks = readerUrl
    ? [
        {
          resourceTitle: "Cambridge GO URL",
          bookTitle: `Reader URL ${readerUrl}`,
          readerUrl,
        },
      ]
    : await selectBrowserBooks(
        args,
        disableProgressTui
          ? await scanBrowserBooks()
          : await runWithInkTask({
              title: "Loading Cambridge GO books",
              run: (emit) =>
                listBrowserAccountBooks({
                  email,
                  password,
                  browserPath,
                  cdpUrl,
                  navigationTimeoutMs,
                  progress: emit,
                }),
            }),
      );

  if (!selectedBooks.length) {
    throw new Error("No Cambridge GO books selected.");
  }

  if (disableProgressTui) {
    console.log(`Selected ${selectedBooks.length} book(s).`);
  }

  const renderSelectedBooks = async (
    emit: (update: ProgressUpdate) => void,
  ): Promise<ReconstructionSummary> => {
    const summary: ReconstructionSummary = { succeeded: [], failed: [] };
    for (const book of selectedBooks) {
      const result = await runBrowserScrape({
        readerUrl: book.readerUrl,
        progressId: book.readerUrl,
        email,
        password,
        outDir,
        tempRoot,
        browserPath,
        cdpUrl,
        navigationTimeoutMs,
        maxPages,
        log: disableProgressTui ? (message) => console.log(message) : undefined,
        emit,
      });
      summary.succeeded.push(...result.succeeded);
      summary.failed.push(...result.failed);
    }
    return summary;
  };

  const uiBooks = browserBooksToUiBooks(selectedBooks);
  const summary = disableProgressTui
    ? await renderSelectedBooks(() => {})
    : await runWithInkProgress({ books: uiBooks, run: renderSelectedBooks });

  if (summary.succeeded.length) {
    console.log("\nGenerated PDFs:");
    for (const filePath of summary.succeeded) {
      console.log(`- ${filePath}`);
    }
  }

  if (summary.failed.length) {
    console.log("\nFailed browser scrape:");
    for (const failure of summary.failed) {
      console.log(`- ${failure.title} (${failure.isbn}): ${failure.error}`);
    }
    throw new Error(`Browser scrape completed with ${summary.failed.length} failure(s).`);
  }
}

async function runBrowserInspectCommand(args: CliArgs): Promise<void> {
  const requestedBrowserPath = getStringArg(args, "browser");
  const cdpUrl = getStringArg(args, "cdp-url") ?? process.env.CLOAKBROWSER_CDP_URL;
  const browserPath = cdpUrl
    ? requestedBrowserPath
    : path.resolve(requestedBrowserPath ?? detectPlaywrightBrowserExecutable());
  const navigationTimeoutMs = getPositiveIntegerArg(args, "page-timeout-ms", 30000);
  const books = await listBrowserAccountBooks({
    email: getStringArg(args, "email"),
    password: getStringArg(args, "password"),
    browserPath,
    cdpUrl,
    navigationTimeoutMs,
    log: (message) => console.log(message),
  });

  if (!books.length) {
    console.log("No Cambridge GO account books detected.");
    return;
  }

  console.log(`Detected ${books.length} Cambridge GO account book(s):`);
  for (const book of books) {
    console.log("");
    console.log(`- ${book.bookTitle}`);
    console.log(`  Resource: ${book.resourceTitle}`);
  }
}

function isDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.CAMBRIDGE_READER_SCRAPER_DOCKER === "1";
}

async function resolveOutputDirectory(args: CliArgs): Promise<string> {
  const explicit = getStringArg(args, "outdir");
  if (explicit) {
    return path.resolve(explicit);
  }

  if (isDocker()) {
    return "/out";
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return path.resolve("out");
  }

  const answer = await promptOutputDirectoryWithInk("out");
  return path.resolve(answer.trim() || "out");
}

function printHelp(): void {
  console.log(renderHelp());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "reconstruct";
  const browserRequested =
    hasFlag(args, "browser-scrape") ||
    Boolean(getStringArg(args, "cdp-url") ?? process.env.CLOAKBROWSER_CDP_URL) ||
    Boolean(getStringArg(args, "url"));
  const browserDefaultCommand =
    command === "inspect" || command === "reconstruct" || command === "pdf";
  const useBrowserScrape = browserRequested || (isDocker() && browserDefaultCommand);

  if (hasFlag(args, "help") || command === "help") {
    printHelp();
    return;
  }

  if (command === "completion") {
    const shell = args._[1];
    if (!shell || !isCompletionShell(shell)) {
      throw new Error(`Unknown shell. Use one of: bash, zsh, fish, powershell.`);
    }

    console.log(renderCompletion(shell));
    return;
  }

  if (useBrowserScrape) {
    if (command === "inspect") {
      await runBrowserInspectCommand(args);
      return;
    }

    if (command === "reconstruct" || command === "pdf") {
      await runBrowserScrapeCommand(args);
      return;
    }
  }

  const userdataRoot = resolveUserdataPath(args);
  const books = await discoverBooks(userdataRoot);

  if (command === "inspect") {
    await runInspectCommand(books, userdataRoot);
    return;
  }

  if (command === "reconstruct" || command === "pdf") {
    await runReconstructCommand(args, books);
    return;
  }

  throw new Error(
    `Unknown command: ${command}. Use 'inspect', 'reconstruct', 'pdf', 'completion', or 'help'.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  console.error(`Run '${CLI_NAME} --help' for usage.`);
  process.exit(1);
});
