// Registry of supported AI coding platforms — each entry knows where
// to drop SKILL.md and how to tell whether the platform is installed
// on this machine.
//
// Design adapted from skills-hub.ai's @skills-hub-ai/cli
// (https://www.npmjs.com/package/@skills-hub-ai/cli, MIT). They
// pioneered the "auto-detect installed clients + install to every
// one" UX for Claude-style skills; we're following their lead so a
// user's existing muscle memory carries over.
//
// Add a platform: append to PLATFORM_REGISTRY. Tests + the install
// command + the `list-platforms` command all read from this one
// source of truth.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type KnownPlatform =
  | "claude-code"
  | "cursor"
  | "codex"
  | "copilot"
  | "windsurf"
  | "cline"
  | "opencode"
  | "continue"
  | "gemini"
  | "roo"
  | "zed";

export type PlatformRegistryEntry = {
  id: KnownPlatform;
  label: string;
  // Where to write skill folders. Resolved at call-time (not at
  // module-load) so tests can override $HOME / cwd.
  path: (env: PlatformEnv) => string;
  // Does this platform appear to be installed? Usually probes its
  // config dir or a known marker file.
  detect: (env: PlatformEnv) => boolean;
};

export type PlatformEnv = {
  home: string;
  cwd: string;
};

export function realEnv(): PlatformEnv {
  return { home: os.homedir(), cwd: process.cwd() };
}

const has = (...segments: string[]) => fs.existsSync(path.join(...segments));

export const PLATFORM_REGISTRY: PlatformRegistryEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    path: (e) => path.join(e.home, ".claude", "skills"),
    detect: (e) => has(e.home, ".claude"),
  },
  {
    id: "cursor",
    label: "Cursor",
    path: (e) => path.join(e.home, ".cursor", "skills"),
    detect: (e) => has(e.home, ".cursor"),
  },
  {
    id: "codex",
    label: "Codex CLI",
    path: (e) => path.join(e.home, ".codex", "skills"),
    detect: (e) => has(e.home, ".codex"),
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    // Copilot uses .github/copilot-instructions.md at workspace root;
    // we drop per-skill folders under .github/copilot/skills/ so the
    // user can opt them in via custom instructions without colliding
    // with the single documented file.
    path: (e) => path.join(e.cwd, ".github", "copilot", "skills"),
    detect: (e) =>
      has(e.cwd, ".github", "copilot") ||
      has(e.cwd, ".github", "copilot-instructions.md"),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    path: (e) => path.join(e.home, ".windsurf", "skills"),
    detect: (e) => has(e.home, ".windsurf") || has(e.cwd, ".windsurfrules"),
  },
  {
    id: "cline",
    label: "Cline",
    path: (e) => path.join(e.home, ".cline", "skills"),
    detect: (e) => has(e.home, ".cline") || has(e.cwd, ".clinerules"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    path: (e) => path.join(e.home, ".opencode", "skills"),
    detect: (e) => has(e.home, ".opencode"),
  },
  {
    id: "continue",
    label: "Continue",
    // Best-effort: Continue uses ~/.continue/config.json; the skills
    // subdir is not yet a documented loader location.
    path: (e) => path.join(e.home, ".continue", "skills"),
    detect: (e) => has(e.home, ".continue"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    // Best-effort: ~/.gemini is the published config root; the
    // skills subdir is not (yet) documented.
    path: (e) => path.join(e.home, ".gemini", "skills"),
    detect: (e) => has(e.home, ".gemini"),
  },
  {
    id: "roo",
    label: "Roo Code",
    path: (e) => path.join(e.home, ".roo", "skills"),
    detect: (e) => has(e.home, ".roo") || has(e.cwd, ".roorules"),
  },
  {
    id: "zed",
    label: "Zed",
    // macOS uses ~/Library/Application Support/Zed; Linux uses
    // ~/.config/zed. We pick per-platform at call time.
    path: (e) => zedPath(e.home),
    detect: (e) => fs.existsSync(path.dirname(zedPath(e.home))),
  },
];

function zedPath(home: string): string {
  if (os.platform() === "darwin") {
    return path.join(home, "Library", "Application Support", "Zed", "skills");
  }
  return path.join(home, ".config", "zed", "skills");
}

export const ALL_PLATFORM_IDS: KnownPlatform[] = PLATFORM_REGISTRY.map(
  (p) => p.id,
);

export function getPlatform(id: string): PlatformRegistryEntry | undefined {
  return PLATFORM_REGISTRY.find((p) => p.id === id);
}

/**
 * Return every platform that appears to be installed on this
 * machine. Order matches registry order, so Claude Code comes first
 * when multiple are present.
 */
export function detectAllPlatforms(env: PlatformEnv = realEnv()): PlatformRegistryEntry[] {
  return PLATFORM_REGISTRY.filter((p) => p.detect(env));
}

/**
 * Parse a comma-separated list of platform IDs from the CLI's
 * --target flag. Splits into known + unknown so the caller can warn
 * the user about typos without silently dropping them.
 */
export function parsePlatformIds(value: string): {
  known: PlatformRegistryEntry[];
  unknown: string[];
} {
  const known: PlatformRegistryEntry[] = [];
  const unknown: string[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (!id) continue;
    const entry = getPlatform(id);
    if (entry) known.push(entry);
    else unknown.push(id);
  }
  return { known, unknown };
}
