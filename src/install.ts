// Install / uninstall skills across one or more AI-coding platforms.
//
// Default behavior (no --target): auto-detect every installed
// platform (Claude Code, Cursor, Codex, Copilot, ...) and write the
// skill to each one. This matches the user's mental model from
// other skills hubs ("install the skill, it shows up everywhere").
//
// Override with `--target claude-code,cursor` (specific platforms)
// or `--dir <path>` (raw directory — useful for clients we don't
// have in the registry yet).
//
// Each install is atomic-ish: copy to a staging dir next to the
// destination, then rename. We refuse to overwrite an existing
// install without --force — silent reinstalls hide problems.

import fs from "node:fs";
import path from "node:path";

import { findBundledSkill } from "./skills.js";
import {
  detectAllPlatforms,
  realEnv,
  type PlatformEnv,
  type PlatformRegistryEntry,
} from "./platforms.js";

export type InstallOpts = {
  slug: string;
  // EXACTLY ONE of these three controls the destination(s):
  //   - targets:  explicit platform IDs (e.g. ["claude-code", "cursor"])
  //   - dir:      raw directory (e.g. "./.claude/skills")
  //   - (none):   auto-detect every installed platform
  targets?: PlatformRegistryEntry[];
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
  // Test-only overrides; never set in production code paths.
  env?: PlatformEnv;
  bundledRoot?: string;
};

export type InstallEntry = {
  // Platform id, or "custom" when --dir was used.
  platform: string;
  label: string;
  installedTo: string;
  status: "installed" | "skipped-exists" | "would-install" | "error";
  reason?: string;
};

export type InstallResult = {
  slug: string;
  entries: InstallEntry[];
};

/**
 * Resolve the list of destinations for an install call. Single
 * function so the CLI can show "what would I install where" in
 * --dry-run mode without duplicating the resolution logic.
 */
export function resolveDestinations(opts: {
  targets?: PlatformRegistryEntry[];
  dir?: string;
  env?: PlatformEnv;
}): Array<{ platform: string; label: string; root: string }> {
  const env = opts.env ?? realEnv();

  if (opts.dir) {
    return [
      { platform: "custom", label: "Custom directory", root: path.resolve(opts.dir) },
    ];
  }
  const platforms = opts.targets ?? detectAllPlatforms(env);
  return platforms.map((p) => ({
    platform: p.id,
    label: p.label,
    root: p.path(env),
  }));
}

export function install(opts: InstallOpts): InstallResult {
  const src = findBundledSkill(opts.slug, opts.bundledRoot);
  if (!src) {
    throw new Error(
      `Skill not found in this package: ${opts.slug}\n` +
        `Run \`dragonbot-skills list\` to see what's available.`,
    );
  }

  const destinations = resolveDestinations({
    targets: opts.targets,
    dir: opts.dir,
    env: opts.env,
  });

  if (destinations.length === 0) {
    throw new Error(
      "No install destinations resolved. None of the supported AI " +
        "coding platforms were detected on this machine. Pass " +
        "--target claude-code (or another platform id, see " +
        "`dragonbot-skills list-platforms`) or --dir <path> to " +
        "install anyway.",
    );
  }

  const entries: InstallEntry[] = [];
  for (const dest of destinations) {
    const installedTo = path.join(dest.root, opts.slug);
    try {
      if (opts.dryRun) {
        entries.push({
          platform: dest.platform,
          label: dest.label,
          installedTo,
          status: "would-install",
        });
        continue;
      }
      if (fs.existsSync(installedTo)) {
        if (!opts.force) {
          entries.push({
            platform: dest.platform,
            label: dest.label,
            installedTo,
            status: "skipped-exists",
            reason: "destination exists; pass --force to overwrite",
          });
          continue;
        }
        fs.rmSync(installedTo, { recursive: true, force: true });
      }
      fs.mkdirSync(dest.root, { recursive: true });
      copyIntoPlace(src, installedTo, opts.slug, dest.root);
      entries.push({
        platform: dest.platform,
        label: dest.label,
        installedTo,
        status: "installed",
      });
    } catch (err) {
      entries.push({
        platform: dest.platform,
        label: dest.label,
        installedTo,
        status: "error",
        reason: (err as Error).message,
      });
    }
  }
  return { slug: opts.slug, entries };
}

export type UninstallOpts = {
  slug: string;
  targets?: PlatformRegistryEntry[];
  dir?: string;
  env?: PlatformEnv;
};

export type UninstallEntry = {
  platform: string;
  label: string;
  path: string;
  removed: boolean;
};

export type UninstallResult = {
  slug: string;
  entries: UninstallEntry[];
};

export function uninstall(opts: UninstallOpts): UninstallResult {
  const destinations = resolveDestinations({
    targets: opts.targets,
    dir: opts.dir,
    env: opts.env,
  });
  const entries: UninstallEntry[] = [];
  for (const dest of destinations) {
    const target = path.join(dest.root, opts.slug);
    if (!fs.existsSync(target)) {
      entries.push({ platform: dest.platform, label: dest.label, path: target, removed: false });
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    entries.push({ platform: dest.platform, label: dest.label, path: target, removed: true });
  }
  return { slug: opts.slug, entries };
}

// Stage in a sibling tmp dir, then rename. Avoids leaving a half-
// copied skill folder behind if the copy is interrupted.
function copyIntoPlace(src: string, dest: string, slug: string, parent: string): void {
  const staging = fs.mkdtempSync(path.join(parent, `.${slug}-staging-`));
  try {
    copyDirRecursive(src, staging);
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
    // Symlinks + special files: skip silently.
  }
}

/** Re-export so the CLI doesn't need to import from two modules. */
export { getPlatform, parsePlatformIds, detectAllPlatforms } from "./platforms.js";
