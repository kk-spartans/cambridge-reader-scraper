# Cambridge Reader Scraper

Rebuilds Cambridge Reader and Cambridge GO books into PDFs.

## Quickstart

Download the compose file:

```bash
mkdir scraper
cd scraper
curl -fsSLO https://raw.githubusercontent.com/kk-spartans/cambridge-reader-scraper/main/devops/docker-compose.yml
```

Create `.env`:

```env
CAMBRIDGE_GO_EMAIL=you@example.com
CAMBRIDGE_GO_PASSWORD=your-password
```

Run it:

```bash
docker compose run --rm scraper
```

The scraper starts CloakBrowser automatically, logs into Cambridge GO, shows a book picker, and writes PDFs to `./out`. I know it's slow, will work on it later.
