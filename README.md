# cambridge-reader-scraper

## Usage

1. Go to [Cambridge GO](https://www.cambridge.org/go/), and make an account.
2. Add your book with the 16-char code if you haven't already.
3. Install cambridge reader:

```
winget install CambridgeUniversityPress.CambridgeReader
```

Or from [Cambridge](https://www.cambridge.org/go/) for MacOS (not tested).

4. Login to it and download the book you want to scrape.
5. Run:

```
pnpx cambridge-reader-scraper # or
npx cambridge-reader-scraper
```

Bun does **not** work well with playwright, so it probably won't work.
