import type { CliArgs } from "./types.js";

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { _: [] };

  const appendValue = (key: string, value: string | boolean): void => {
    const current = out[key];
    if (current === undefined) {
      out[key] = value;
      return;
    }
    if (Array.isArray(current)) {
      current.push(String(value));
      out[key] = current;
      return;
    }
    out[key] = [String(current), String(value)];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      continue;
    }

    if (token === "-h" || token === "-?") {
      appendValue("help", true);
      continue;
    }

    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }

    const key = token.slice(2);
    const maybeValue = argv[index + 1];
    if (!maybeValue || maybeValue.startsWith("--")) {
      appendValue(key, true);
      continue;
    }

    appendValue(key, maybeValue);
    index += 1;
  }

  return out;
}

export function getStringArg(args: CliArgs, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  if (typeof value === "boolean") {
    return fallback;
  }
  return value;
}

export function getStringListArg(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return [];
  }
  return [value];
}

function getNumberArg(args: CliArgs, key: string): number | undefined {
  const raw = getStringArg(args, key);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getPositiveIntegerArg(args: CliArgs, key: string, fallback: number): number {
  const parsed = getNumberArg(args, key);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function hasFlag(args: CliArgs, key: string): boolean {
  const value = args[key];
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => item === "true");
  }
  return value === true || value === "true";
}
