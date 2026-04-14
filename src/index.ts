import * as path from "node:path";

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
import { promptOutputDirectoryWithInk, runWithInkProgress, selectBooksWithInk } from "./tui.js";
import type { BookInfo, CliArgs, UiBook } from "./types.js";

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

async function resolveOutputDirectory(args: CliArgs): Promise<string> {
  const explicit = getStringArg(args, "outdir");
  if (explicit) {
    return path.resolve(explicit);
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

  if (hasFlag(args, "help") || command === "help") {
    printHelp();
    return;
  }

  if (command === "completion") {
    const shell = args._[1];
    if (!shell || !isCompletionShell(shell)) {
      throw new Error(`Unknown shell. Use one of: bash, zsh, fish, powershell, xonsh.`);
    }

    console.log(renderCompletion(shell));
    return;
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
  process.exitCode = 1;
});
