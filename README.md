# cambridge-reader-scraper

Reconstruct Cambridge Reader offline book blobs into searchable PDFs.

## Install

```bash
pnpm install
```

## Inspect discovered books

```bash
pnpm run cli -- inspect
```

By default, the appdata root is auto-discovered:

- Windows: `%LOCALAPPDATA%/Cambridge Reader` (and common name variants)
- macOS (Electron-style): `~/Library/Application Support/<app-name>`
- Linux (Electron-style): `~/.config/<app-name>` and `~/.local/share/<app-name>`

You can override it any time:

```bash
pnpm run cli -- inspect --userdata "C:\path\to\userdata"
```

## Reconstruct to PDF

```bash
pnpm run cli -- reconstruct --outdir ./out
```

If run in a TTY, this opens an interactive Ink UI:

- arrow keys to move
- type to search
- space to multi-select
- enter to start
- ctrl+c to cancel and exit immediately

Progress is shown with live bars per book (not per-page spam logs).

Output filenames now default to the book title (sanitized), not ISBN.

PDF generation now uses Chromium print-to-PDF from merged HTML pages, so selectable text can be preserved when the underlying page HTML/text layer is available.

Chapter/subchapter TOC is extracted from EPUB nav/NCX when present and included in the PDF front matter and outlines.

### Useful flags

- `--isbn <isbn>`: reconstruct only matching ISBN (repeatable)
- `--max-pages <n>`: reconstruct only first N pages
- `--workdir <dir>`: extraction workspace directory
- `--keep-extracted`: keep extracted EPUB files instead of deleting
- `--browser <path>`: explicit Playwright Chromium executable path
- `--page-timeout-ms <n>`: timeout per page navigation/render wait (default `20000`)
- `--concurrency <n>`: number of books to process in parallel (default `1`)
- `--app-name <name>`: appdata app folder name used for auto-detection (default `Cambridge Reader`)
- `--no-tui`: disable interactive TUI and progress UI

By default the script auto-detects the Playwright-installed Chromium executable from `%LOCALAPPDATA%\\ms-playwright` (`chromium-*`/`chromium_headless_shell-*`, including win64 folder layouts).

## Quality checks

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
```

Single CLI entrypoint: `pnpm run cli -- <command>` (or `pnpm start -- <command>`).

Linting uses `.oxlintrc.json` with type-aware analysis enabled and complexity-family rules explicitly disabled. `typecheck` runs `oxlint --type-aware --type-check`.
