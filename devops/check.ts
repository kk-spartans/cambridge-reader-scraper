import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

function isDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.CAMBRIDGE_READER_SCRAPER_DOCKER === "1";
}

function isMissingCommand(error: Error | undefined): boolean {
  return Boolean(error && "code" in error && error.code === "ENOENT");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function runGitleaks(): void {
  const result = spawnSync("gitleaks", ["protect", "--staged", "--redact", "--verbose"], {
    stdio: "inherit",
  });
  if (isMissingCommand(result.error) && isDocker()) {
    console.warn("gitleaks not found in Docker; skipping secret scan");
    return;
  }
  if (isMissingCommand(result.error)) {
    throw new Error("gitleaks not found");
  }
  if (result.status !== 0) {
    throw new Error("gitleaks protect --staged --redact --verbose failed");
  }
}

function writeBinaryEntrypoint(): void {
  const binPath = "dist/cambridge-reader-scraper";
  writeFileSync(binPath, "#!/usr/bin/env node\nimport './index.js';\n");
  chmodSync(binPath, 0o755);
}

function generateCompletions(): void {
  if (isDocker()) {
    console.warn("running in Docker; skipping completion generation");
    return;
  }

  const outputDir = "dist/completions";

  mkdirSync(outputDir, { recursive: true });

  for (const entry of readdirSync(outputDir)) {
    rmSync(`${outputDir}/${entry}`);
  }

  const shells: Array<[string, string]> = [
    ["bash", "cambridge-reader-scraper.bash"],
    ["zsh", "_cambridge-reader-scraper"],
    ["fish", "cambridge-reader-scraper.fish"],
    ["powershell", "cambridge-reader-scraper.ps1"],
  ];

  for (const [shell, filename] of shells) {
    const result = spawnSync(
      "usage",
      ["generate", "completion", shell, "cambridge-reader-scraper", "-f", "devops/usage.kdl"],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) {
      if (isMissingCommand(result.error)) {
        throw new Error("usage not found");
      }
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`usage generate completion ${shell} failed`);
    }
    writeFileSync(`${outputDir}/${filename}`, result.stdout);
  }
}

const steps: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "gitleaks",
    run: () => {
      runGitleaks();
    },
  },
  {
    name: "build",
    run: () => {
      run("tsc", ["-p", "devops/tsconfig.build.json"]);
      writeBinaryEntrypoint();
      generateCompletions();
    },
  },
  {
    name: "oxlint",
    run: () => {
      run("oxlint", [
        "--type-aware",
        "--config",
        "devops/oxlintrc.json",
        "--tsconfig",
        "devops/tsconfig.json",
        "src",
      ]);
    },
  },
  {
    name: "oxfmt",
    run: () => {
      run("oxfmt", ["--write", ".", "--config", "devops/oxfmtrc.json"]);
    },
  },
  {
    name: "knip",
    run: () => {
      run("knip", ["--config", "devops/knip.json"]);
    },
  },
  {
    name: "e18e",
    run: () => {
      run("e18e-cli", ["analyze", "--log-level", "error"]);
    },
  },
  {
    name: "typecheck", // oxlint's type-check mode isn't fully compatable and it's really annoying
    run: () => {
      run("tsc", ["--noEmit", "-p", "devops/tsconfig.json"]);
    },
  },
];

const failures: Array<{ step: string; error: string }> = [];

for (const step of steps) {
  try {
    console.log(`\n==> ${step.name}`);
    await step.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n!! ${step.name} failed:\n   ${message}`);
    failures.push({ step: step.name, error: message });
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} step(s) failed:`);
  for (const { step, error } of failures) {
    console.error(`  - ${step}: ${error}`);
  }
  process.exit(1);
}
