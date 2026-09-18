# Docs

This is the Fumadocs site for `cambridge-reader-scraper`.

## Local commands

```bash
pnpm --dir docs dev
pnpm --dir docs lint
pnpm --dir docs typecheck
pnpm --dir docs build
```

The production build writes a static export to `docs/out/`. This repo currently has
no GitHub Pages deployment workflow, so building does not publish the site.
For a manual Pages deployment, build with `GITHUB_ACTIONS=true pnpm --dir docs build`
from the repository root to include the `/cambridge-reader-scraper` base path,
then publish `docs/out/` using your deployment tooling.
