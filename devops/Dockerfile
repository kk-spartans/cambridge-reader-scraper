FROM node:24-bookworm-slim AS deps

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM deps AS build

ENV CAMBRIDGE_READER_SCRAPER_DOCKER=1
COPY . .
RUN pnpm run check

FROM gcr.io/distroless/nodejs24-debian12 AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENTRYPOINT ["/nodejs/bin/node", "dist/cambridge-reader-scraper"]
