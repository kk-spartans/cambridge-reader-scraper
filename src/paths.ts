import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CliArgs } from "./types.js";
import { getStringArg } from "./cli.js";

function normalizePathCase(value: string): string {
  if (process.platform === "win32") {
    return value.toLowerCase();
  }
  return value;
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const absolute = path.resolve(value);
    const normalized = normalizePathCase(absolute);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(absolute);
  }

  return out;
}

function sanitizeAppDataName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, "").trim();
}

export function inferDefaultUserdataPaths(appNameInput: string): string[] {
  const appNameRaw = appNameInput.trim() || "Cambridge Reader";
  const appName = sanitizeAppDataName(appNameRaw) || "Cambridge Reader";
  const compactName = appName.replace(/[\s_-]+/g, "");

  const candidates: string[] = [];

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(path.join(local, appName));
    candidates.push(path.join(local, compactName));
    candidates.push(path.join(local, `${appName} Reader`));
    candidates.push(path.join(local, `${compactName}Reader`));
  }

  if (process.platform === "darwin") {
    const library = path.join(os.homedir(), "Library");
    candidates.push(path.join(library, "Application Support", appName));
    candidates.push(path.join(library, "Application Support", compactName));
    candidates.push(path.join(library, "Caches", appName));
  }

  if (process.platform === "linux") {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    candidates.push(path.join(xdgConfig, appName));
    candidates.push(path.join(xdgConfig, compactName));
    candidates.push(path.join(xdgData, appName));
    candidates.push(path.join(xdgData, compactName));
  }

  candidates.push(path.resolve("userdata"));

  return uniquePaths(candidates);
}

export function resolveUserdataPath(args: CliArgs): string {
  const explicit = getStringArg(args, "userdata");
  if (explicit) {
    return path.resolve(explicit);
  }

  const appName = getStringArg(args, "app-name", "Cambridge Reader") ?? "Cambridge Reader";
  const candidates = inferDefaultUserdataPaths(appName);

  for (const candidate of candidates) {
    const blobRoot = path.join(candidate, "Default", "File System", "000", "p", "00");
    if (existsSync(blobRoot)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve("userdata");
}

export function safeFileName(value: string): string {
  const withoutControlCharacters = Array.from(value)
    .filter((character) => {
      const codePoint = character.charCodeAt(0);
      return !(codePoint >= 0 && codePoint <= 0x1f);
    })
    .join("");

  const sanitized = value
    .replace(/\r|\n|\t/g, " ")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const fallbackSanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const chosen = sanitized || fallbackSanitized;

  if (!chosen) {
    return "untitled-book";
  }

  return chosen;
}
