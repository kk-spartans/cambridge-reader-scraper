import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-3 font-semibold tracking-tight">
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs uppercase text-cyan-200">
            CRS
          </span>
          {appName}
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
