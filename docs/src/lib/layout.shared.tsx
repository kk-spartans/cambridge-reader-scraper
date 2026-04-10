import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-3 font-semibold tracking-tight text-zinc-100">
          <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs uppercase text-zinc-200">
            CRS
          </span>
          {appName}
        </span>
      ),
    },
    searchToggle: {
      enabled: true,
    },
    themeSwitch: {
      enabled: false,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
