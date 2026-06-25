// Registry of supported AI coding platforms — each entry knows
// where to drop a skill folder and how to tell whether the platform
// is installed on this machine.
//
// Most platforms use the simple "<dir>/<slug>/SKILL.md" convention
// (Claude Code, Cursor, Codex, etc.). A few use richer formats —
// notably Cowork and Claude Desktop, which load skills as plugin
// bundles (.claude-plugin/plugin.json + manifest.json + skills/<slug>).
// For those, the entry carries a `customInstaller` callback that
// owns the full install/uninstall flow.
//
// Standard-platform layout adapted from skills-hub.ai's
// @skills-hub-ai/cli (MIT). They pioneered the auto-detect-and-
// install-everywhere UX for Claude-style skills.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  installToCowork,
  uninstallFromCowork,
  appPluginRoot,
  bundleDir,
} from "./cowork-plugin.js";

export type KnownPlatform =
  | "claude-code"
  | "claude-desktop"
  | "cowork"
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

export type PlatformEnv = {
  home: string;
  cwd: string;
};

export function realEnv(): PlatformEnv {
  return { home: os.homedir(), cwd: process.cwd() };
}

const has = (...segments: string[]) => fs.existsSync(path.join(...segments));

// Inputs to a custom installer. The standard "copy <srcSkillDir>
// into <skillsRoot>/<slug>" pattern is too narrow for Cowork
// (which also needs to merge a manifest.json), so custom platforms
// own the full flow.
export type CustomInstallArgs = {
  env: PlatformEnv;
  srcSkillDir: string;
  slug: string;
  name: string;
  description: string;
  pluginVersion: string;
  force?: boolean;
};

export type CustomInstallResult = {
  installedTo: string;
  status: "installed" | "skipped-exists" | "error";
  reason?: string;
};

export type CustomUninstallArgs = {
  env: PlatformEnv;
  slug: string;
};

export type CustomUninstallResult = {
  path: string;
  removed: boolean;
};

export type CustomInstaller = {
  install: (args: CustomInstallArgs) => CustomInstallResult;
  uninstall: (args: CustomUninstallArgs) => CustomUninstallResult;
};

export type PlatformRegistryEntry = {
  id: KnownPlatform;
  label: string;
  // Where skill folders ultimately live. Shown in `list-platforms`
  // so users can see the target before installing.
  skillsRoot: (env: PlatformEnv) => string;
  // Is this platform installed on this machine?
  detect: (env: PlatformEnv) => boolean;
  // Override the default copy-to-<skillsRoot>/<slug> behavior.
  // Required for plugin-bundle-style platforms (Cowork, Claude Desktop).
  customInstaller?: CustomInstaller;
};

const coworkInstaller = (app: "claude-desktop" | "cowork"): CustomInstaller => ({
  install: (args) => {
    try {
      const result = installToCowork({ app, ...args });
      return {
        installedTo: result.bundlePath,
        status: result.installed ? "installed" : "skipped-exists",
        reason: result.reason,
      };
    } catch (err) {
      return {
        installedTo: path.join(bundleDir(app, args.env), "skills", args.slug),
        status: "error",
        reason: (err as Error).message,
      };
    }
  },
  uninstall: (args) => {
    const result = uninstallFromCowork({ app, ...args });
    return { path: result.bundlePath, removed: result.removed };
  },
});

export const PLATFORM_REGISTRY: PlatformRegistryEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    skillsRoot: (e) => path.join(e.home, ".claude", "skills"),
    detect: (e) => has(e.home, ".claude"),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    // Custom installer writes the plugin bundle; the "skillsRoot"
    // we expose for list-platforms / dry-run is the bundle's
    // skills/ subdir.
    skillsRoot: (e) => path.join(bundleDir("claude-desktop", e), "skills"),
    detect: (e) => fs.existsSync(appPluginRoot("claude-desktop", e)),
    customInstaller: coworkInstaller("claude-desktop"),
  },
  {
    id: "cowork",
    label: "Claude Cowork",
    skillsRoot: (e) => path.join(bundleDir("cowork", e), "skills"),
    detect: (e) => fs.existsSync(appPluginRoot("cowork", e)),
    customInstaller: coworkInstaller("cowork"),
  },
  {
    id: "cursor",
    label: "Cursor",
    skillsRoot: (e) => path.join(e.home, ".cursor", "skills"),
    detect: (e) => has(e.home, ".cursor"),
  },
  {
    id: "codex",
    label: "Codex CLI",
    skillsRoot: (e) => path.join(e.home, ".codex", "skills"),
    detect: (e) => has(e.home, ".codex"),
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    // Copilot uses .github/copilot-instructions.md at workspace root;
    // we drop per-skill folders under .github/copilot/skills/ so the
    // user can opt them in via custom instructions without colliding
    // with the single documented file.
    skillsRoot: (e) => path.join(e.cwd, ".github", "copilot", "skills"),
    detect: (e) =>
      has(e.cwd, ".github", "copilot") ||
      has(e.cwd, ".github", "copilot-instructions.md"),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    skillsRoot: (e) => path.join(e.home, ".windsurf", "skills"),
    detect: (e) => has(e.home, ".windsurf") || has(e.cwd, ".windsurfrules"),
  },
  {
    id: "cline",
    label: "Cline",
    skillsRoot: (e) => path.join(e.home, ".cline", "skills"),
    detect: (e) => has(e.home, ".cline") || has(e.cwd, ".clinerules"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    skillsRoot: (e) => path.join(e.home, ".opencode", "skills"),
    detect: (e) => has(e.home, ".opencode"),
  },
  {
    id: "continue",
    label: "Continue",
    // Best-effort: Continue uses ~/.continue/config.json; the skills
    // subdir is not yet a documented loader location.
    skillsRoot: (e) => path.join(e.home, ".continue", "skills"),
    detect: (e) => has(e.home, ".continue"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    // Best-effort: ~/.gemini is the published config root; the
    // skills subdir is not (yet) documented.
    skillsRoot: (e) => path.join(e.home, ".gemini", "skills"),
    detect: (e) => has(e.home, ".gemini"),
  },
  {
    id: "roo",
    label: "Roo Code",
    skillsRoot: (e) => path.join(e.home, ".roo", "skills"),
    detect: (e) => has(e.home, ".roo") || has(e.cwd, ".roorules"),
  },
  {
    id: "zed",
    label: "Zed",
    // macOS uses ~/Library/Application Support/Zed; Linux uses
    // ~/.config/zed. We pick per-platform at call time.
    skillsRoot: (e) => zedSkillsRoot(e.home),
    detect: (e) => fs.existsSync(path.dirname(zedSkillsRoot(e.home))),
  },
];

function zedSkillsRoot(home: string): string {
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

export function detectAllPlatforms(env: PlatformEnv = realEnv()): PlatformRegistryEntry[] {
  return PLATFORM_REGISTRY.filter((p) => p.detect(env));
}

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
