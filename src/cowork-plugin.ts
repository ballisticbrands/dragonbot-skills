// Cowork / Claude Desktop "plugin bundle" installer.
//
// Cowork and Claude Desktop don't load skills from ~/.claude/skills/.
// They load them from a per-app plugin tree under:
//
//   ~/Library/Application Support/<App>/local-agent-mode-sessions/skills-plugin/
//     <plugin-uuid>/<snapshot-uuid>/
//       .claude-plugin/plugin.json    {name, version, description}
//       manifest.json                  {lastUpdated, skills: [...]}
//       skills/<slug>/SKILL.md         (+ nested files)
//
// Each "plugin" is a bundle of one or more skills. We ship our
// catalog as a single bundle named "dragonbot-skills". The UUIDs in
// the path are hardcoded so subsequent installs (and --force
// reinstalls) land in the same directory, and the manifest is
// merged across calls so `install amazon-kw-research` followed by
// `install other-skill` ends up with both listed under the same
// plugin.
//
// Unknowns we accept:
//   - Cowork's docs don't describe a user-installable plugin path;
//     this layout is reverse-engineered from the Anthropic-managed
//     skills bundle that ships with the app. It may not load until
//     Cowork is restarted, and could in theory be wiped on resync.
//     Mark this installer as best-effort in the README.

import fs from "node:fs";
import path from "node:path";

import type { PlatformEnv } from "./platforms.js";
import { prefixSkillFileName } from "./skills.js";

// Bundle identity. Stable forever for this package — same on every
// machine, so reinstalls find the right directory.
//
// Generated with crypto.randomUUID(); not derived from the package
// name. If we ever ship multiple plugin bundles, give each its own
// pair of UUIDs.
export const DRAGONBOT_PLUGIN_UUID = "d4a900b1-7e3f-4b8a-9c1d-2e3f4a5b6c7d";
export const DRAGONBOT_SNAPSHOT_UUID = "f1e2d3c4-5b6a-7c80-9d12-3456789abcde";

export const PLUGIN_NAME = "dragonbot-skills";
export const PLUGIN_DESCRIPTION =
  "Amazon analytics + ops skills for Claude (DragonBot catalog).";

export type CoworkApp = "claude-desktop" | "cowork";

const APP_SUBDIRS: Record<CoworkApp, string> = {
  // Both apps live under ~/Library/Application Support on macOS.
  // Claude is the consumer Desktop app, Claude-Work is Cowork.
  "claude-desktop": "Claude",
  cowork: "Claude-Work",
};

/**
 * Absolute path to the app-specific plugin bundle directory for our
 * plugin. Doesn't check whether the dir exists yet.
 */
export function bundleDir(app: CoworkApp, env: PlatformEnv): string {
  return path.join(
    env.home,
    "Library",
    "Application Support",
    APP_SUBDIRS[app],
    "local-agent-mode-sessions",
    "skills-plugin",
    DRAGONBOT_PLUGIN_UUID,
    DRAGONBOT_SNAPSHOT_UUID,
  );
}

/**
 * Path to the parent "skills-plugin" dir for an app. Used by the
 * detect() probe — if this dir exists, the app is installed and
 * supports plugin-style skills.
 */
export function appPluginRoot(app: CoworkApp, env: PlatformEnv): string {
  return path.join(
    env.home,
    "Library",
    "Application Support",
    APP_SUBDIRS[app],
    "local-agent-mode-sessions",
    "skills-plugin",
  );
}

export type ManifestSkill = {
  skillId: string;
  name: string;
  description: string;
  creatorType: "anthropic" | "third-party" | "user";
  updatedAt: string | null;
  enabled: boolean;
};

export type Manifest = {
  lastUpdated: number;
  skills: ManifestSkill[];
};

/**
 * Install a single skill into the Cowork/Claude-Desktop plugin
 * bundle for `app`. Atomic-ish: stages the new skill folder under a
 * tmp name and renames into place. The manifest is updated in
 * place — read, splice/replace the entry for `slug`, write back.
 *
 * `pluginVersion` becomes the `version` field in plugin.json. Bump
 * it when our skill content changes so Cowork can detect updates;
 * we default to the CLI's own package version.
 */
export function installToCowork(args: {
  app: CoworkApp;
  env: PlatformEnv;
  srcSkillDir: string;     // absolute path to the bundled skill folder
  slug: string;
  name: string;
  description: string;
  pluginVersion: string;
  force?: boolean;
}): { installed: boolean; reason?: string; bundlePath: string } {
  const dir = bundleDir(args.app, args.env);
  const skillsDir = path.join(dir, "skills");
  const skillDest = path.join(skillsDir, args.slug);

  if (fs.existsSync(skillDest) && !args.force) {
    return {
      installed: false,
      bundlePath: skillDest,
      reason: "destination exists; pass --force to overwrite",
    };
  }

  fs.mkdirSync(skillsDir, { recursive: true });

  // Write/refresh plugin.json — cheap, ensures version bumps land.
  const pluginJsonDir = path.join(dir, ".claude-plugin");
  fs.mkdirSync(pluginJsonDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginJsonDir, "plugin.json"),
    JSON.stringify(
      { name: PLUGIN_NAME, version: args.pluginVersion, description: PLUGIN_DESCRIPTION },
      null,
      2,
    ) + "\n",
  );

  // Copy skill folder atomically.
  if (fs.existsSync(skillDest)) {
    fs.rmSync(skillDest, { recursive: true, force: true });
  }
  const staging = fs.mkdtempSync(path.join(skillsDir, `.${args.slug}-staging-`));
  try {
    copyDirRecursive(args.srcSkillDir, staging);
    fs.renameSync(staging, skillDest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // Namespace the skill's own `name:` to match its prefixed folder.
  prefixSkillFileName(path.join(skillDest, "SKILL.md"));

  // Merge into manifest.
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = readManifest(manifestPath);
  upsertSkill(manifest, {
    skillId: args.slug,
    name: args.name,
    description: args.description,
    creatorType: "third-party",
    updatedAt: new Date().toISOString(),
    enabled: true,
  });
  manifest.lastUpdated = Date.now();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return { installed: true, bundlePath: skillDest };
}

/**
 * Remove a single skill from the bundle. If it was the last skill,
 * removes the whole plugin directory so we don't leave an empty
 * plugin advertised in Cowork's plugin list.
 */
export function uninstallFromCowork(args: {
  app: CoworkApp;
  env: PlatformEnv;
  slug: string;
}): { removed: boolean; bundlePath: string } {
  const dir = bundleDir(args.app, args.env);
  const skillDest = path.join(dir, "skills", args.slug);
  if (!fs.existsSync(skillDest)) {
    return { removed: false, bundlePath: skillDest };
  }
  fs.rmSync(skillDest, { recursive: true, force: true });

  const manifestPath = path.join(dir, "manifest.json");
  const manifest = readManifest(manifestPath);
  manifest.skills = manifest.skills.filter((s) => s.skillId !== args.slug);
  manifest.lastUpdated = Date.now();

  if (manifest.skills.length === 0) {
    // Last skill — wipe the whole plugin dir so Cowork doesn't
    // load an empty bundle.
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return { removed: true, bundlePath: skillDest };
}

function readManifest(p: string): Manifest {
  if (!fs.existsSync(p)) {
    return { lastUpdated: Date.now(), skills: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
    // Be lenient — start fresh if the existing file is garbled
    // rather than crashing the user mid-install.
    if (typeof parsed !== "object" || !Array.isArray(parsed.skills)) {
      return { lastUpdated: Date.now(), skills: [] };
    }
    return parsed;
  } catch {
    return { lastUpdated: Date.now(), skills: [] };
  }
}

function upsertSkill(manifest: Manifest, entry: ManifestSkill): void {
  const i = manifest.skills.findIndex((s) => s.skillId === entry.skillId);
  if (i < 0) manifest.skills.push(entry);
  else manifest.skills[i] = entry;
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
  }
}
