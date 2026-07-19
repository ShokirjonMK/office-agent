#!/usr/bin/env node
// Windows-only patch for Paperclip's local ACP engine.
//
// On Windows, Paperclip writes a bash ".sh" agent wrapper, but the bundled
// `acpx` runtime can only spawn .exe/.cmd/.bat and parses the agent command
// with a shell-style splitter (backslash = escape, preserved only inside single
// quotes). The result: claude_local agents fail with "Failed to spawn agent
// command ... .sh". This patch makes writeAgentWrapper hand acpx a single-quoted
// "'<git-bash.exe>' '<wrapper.sh>'" command so Git Bash runs the wrapper.
//
// No-op on non-Windows (the .sh wrapper runs natively there). Idempotent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2] || path.resolve("paperclip");
const target = path.join(repo, "packages/adapter-utils/src/acpx-engine/execute.ts");

if (process.platform !== "win32") {
  console.log("[patch] non-Windows platform — bash .sh wrappers run natively, skipping.");
  process.exit(0);
}
if (!existsSync(target)) {
  console.error(`[patch] target not found: ${target}`);
  process.exit(1);
}

let src = readFileSync(target, "utf8");
if (src.includes("resolveGitBashExecutable")) {
  console.log("[patch] already applied.");
  process.exit(0);
}

// 1) import existsSync
if (!src.includes('import { existsSync } from "node:fs"')) {
  src = src.replace(
    'import fs from "node:fs/promises";',
    'import fs from "node:fs/promises";\nimport { existsSync } from "node:fs";',
  );
}

// 2) helper before writeAgentWrapper
const helper = `function resolveGitBashExecutable(): string {
  const override = process.env.PAPERCLIP_GIT_BASH?.trim();
  if (override && existsSync(override)) return override;
  const candidates = [
    "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe",
    "C:\\\\Program Files (x86)\\\\Git\\\\bin\\\\bash.exe",
    "C:\\\\Program Files\\\\Git\\\\usr\\\\bin\\\\bash.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "bash";
}

async function writeAgentWrapper(input: {
  stateDir: string;`;
src = src.replace("async function writeAgentWrapper(input: {\n  stateDir: string;", helper);

// 3) return a single-quoted git-bash command on win32
const oldReturn = `  await cleanupStaleAgentWrappers({
    wrappersDir,
    currentFileNames: new Set([path.basename(wrapperPath), path.basename(envFilePath)]),
  });
  return { wrapperPath, envFilePath };`;
const newReturn = `  let spawnCommand = wrapperPath;
  if (process.platform === "win32") {
    const gitBash = resolveGitBashExecutable();
    spawnCommand = \`'\${gitBash}' '\${wrapperPath}'\`;
  }
  await cleanupStaleAgentWrappers({
    wrappersDir,
    currentFileNames: new Set([path.basename(wrapperPath), path.basename(envFilePath)]),
  });
  return { wrapperPath: spawnCommand, envFilePath };`;
if (!src.includes(oldReturn)) {
  console.error("[patch] could not find the writeAgentWrapper return block — Paperclip version may differ.");
  process.exit(1);
}
src = src.replace(oldReturn, newReturn);

writeFileSync(target, src);
console.log("[patch] applied Windows Git-Bash wrapper fix to execute.ts");
