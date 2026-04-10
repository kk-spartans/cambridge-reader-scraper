# Cambridge Reader Scraper

Rebuilds Cambridge Reader books into PDFs so you do not have to keep suffering through their app.

Docs live at <https://kk-spartans.github.io/cambridge-reader-scraper/>.

## Usage

1. Go to [Cambridge GO](https://www.cambridge.org/go/), and make an account.
2. Add your book with the 16-char code if you haven't already.
3. Install Cambridge Reader:

```
winget install CambridgeUniversityPress.CambridgeReader
```

Or from [Cambridge](https://www.cambridge.org/go/) for MacOS (not tested).

4. Login to it and download the book you want to scrape.
5. Install Playwright Chromium:

```
pnpm dlx playwright install chromium
# or
npx playwright install chromium
# or
bunx playwright install chromium
```

6. Run the scraper:

```bash
pnpm dlx cambridge-reader-scraper
```

```bash
npx cambridge-reader-scraper
```

```bash
bunx cambridge-reader-scraper
```

If you do not pass `--outdir`, the CLI asks where to save the PDFs and defaults to `out` when you just hit Enter.
