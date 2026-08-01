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

## Development

Requires [devenv](https://devenv.sh), [Nix](https://nixos.org), and Docker.

```bash
git clone https://github.com/kk-spartans/cambridge-reader-scraper
cd cambridge-reader-scraper
devenv shell
```

The devenv provides `arion` and `docker-compose`. The dev composition is declared in `devops/arion-compose.nix` and builds the scraper image with Nix (`devops/docker.nix`).

Create `.env` as above, then run:

```bash
devenv tasks run cambridge-reader-scraper:scrape
```

or directly:

```bash
arion -f devops/arion-compose.nix -p devops/arion-pkgs.nix run --rm scraper
```

## Building the Docker image

```bash
nix build .#docker
docker load < result
```
