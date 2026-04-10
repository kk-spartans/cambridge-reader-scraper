import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const repo = "cambridge-reader-scraper";
const isGitHubPagesBuild = process.env.GITHUB_ACTIONS === "true";
const basePath = isGitHubPagesBuild ? `/${repo}` : "";

/** @type {import('next').NextConfig} */
const config = {
  assetPrefix: basePath,
  basePath,
  images: {
    unoptimized: true,
  },
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
};

export default withMDX(config);
