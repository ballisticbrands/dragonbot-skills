// Install / uninstall skills across one or more AI-coding platforms.
//
// Default behavior (no --target): auto-detect every installed
// platform and write the skill to each one. Most platforms get the
// simple "<skillsRoot>/<slug>/" copy; Cowork and Claude Desktop go
// through their plugin-bundle installer (writes .claude-plugin/
// plugin.json + manifest.json + skills/<slug>/) instead.
//
// Override with `--target claude-code,cursor` (specific platforms)
// or `--dir <path>` (raw directory). `--dir` always uses the simple
// copy; the plugin-bundle installer is reachable only via the
// `cowork` / `claude-desktop` platform ids.
//
// Each standard install is atomic-ish: copy to a staging dir next
// to the destination, then rename. Custom installers handle their
// own atomicity (see src/cowork-plugin.ts).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findBundledSkill,
  listBundledSkills,
  withDragonbotPrefix,
  stripDragonbotPrefix,
  prefixSkillFileName,
} from "./skills.js";
import {
  detectAllPlatforms,
  realEnv,
  type PlatformEnv,
  type PlatformRegistryEntry,
} from "./platforms.js";

export type InstallOpts = {
  slug: string;
  // EXACTLY ONE of these three controls the destination(s):
  //   - targets: explicit platform IDs
  //   - dir:     raw directory (always uses standard copy)
  //   - (none):  auto-detect every installed platform
  targets?: PlatformRegistryEntry[];
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
  // Test-only overrides.
  env?: PlatformEnv;
  bundledRoot?: string;
  packageVersion?: string;
};

export type InstallEntry = {
  platform: string;       // platform id, or "custom" when --dir was used
  label: string;
  installedTo: string;
  status: "installed" | "skipped-exists" | "would-install" | "error";
  reason?: string;
};

export type InstallResult = {
  slug: string;
  entries: InstallEntry[];
};

type Destination = {
  platform: string;
  label: string;
  /** Where this skill will land — `<skillsRoot>/<slug>` (or the bundle's equivalent). */
  skillPath: string;
  /** When set, run the platform's custom installer instead of standard copy. */
  entry?: PlatformRegistryEntry;
};

/** Resolve where install() will write, given the user's flags. */
export function resolveDestinations(opts: {
  slug: string;
  targets?: PlatformRegistryEntry[];
  dir?: string;
  env?: PlatformEnv;
}): Destination[] {
  const env = opts.env ?? realEnv();

  // The installed folder is always namespaced; the catalog slug the
  // user typed is not. dragonbot-amazon-kw-research lands on disk even
  // though you install it as `amazon-kw-research`.
  const installSlug = withDragonbotPrefix(opts.slug);

  if (opts.dir) {
    return [
      {
        platform: "custom",
        label: "Custom directory",
        skillPath: path.join(path.resolve(opts.dir), installSlug),
      },
    ];
  }
  const platforms = opts.targets ?? detectAllPlatforms(env);
  return platforms.map((p) => ({
    platform: p.id,
    label: p.label,
    skillPath: path.join(p.skillsRoot(env), installSlug),
    entry: p,
  }));
}

export function install(opts: InstallOpts): InstallResult {
  // Accept either the bare catalog slug or an already-prefixed one;
  // the source folder in the package is always the bare slug.
  const catalogSlug = stripDragonbotPrefix(opts.slug);
  const installSlug = withDragonbotPrefix(opts.slug);
  const src = findBundledSkill(catalogSlug, opts.bundledRoot);
  if (!src) {
    throw new Error(
      `Skill not found in this package: ${catalogSlug}\n` +
        `Run \`dragonbot-skills list\` to see what's available.`,
    );
  }

  const env = opts.env ?? realEnv();
  const destinations = resolveDestinations({
    slug: catalogSlug,
    targets: opts.targets,
    dir: opts.dir,
    env,
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

  const skillMeta = listBundledSkills(opts.bundledRoot).find(
    (s) => s.slug === catalogSlug,
  );
  const skillName = withDragonbotPrefix(skillMeta?.name ?? catalogSlug);
  const skillDescription = skillMeta?.description ?? "";
  const pluginVersion = opts.packageVersion ?? detectPackageVersion();

  const entries: InstallEntry[] = [];
  for (const dest of destinations) {
    if (opts.dryRun) {
      entries.push({
        platform: dest.platform,
        label: dest.label,
        installedTo: dest.skillPath,
        status: "would-install",
      });
      continue;
    }

    // Custom installer (Cowork / Claude Desktop plugin bundle).
    if (dest.entry?.customInstaller) {
      const result = dest.entry.customInstaller.install({
        env,
        srcSkillDir: src,
        slug: installSlug,
        name: skillName,
        description: skillDescription,
        pluginVersion,
        force: opts.force,
      });
      entries.push({
        platform: dest.platform,
        label: dest.label,
        installedTo: result.installedTo,
        status: result.status,
        reason: result.reason,
      });
      continue;
    }

    // Standard "<dir>/<slug>" copy.
    try {
      const installedTo = dest.skillPath;
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
      const parentDir = path.dirname(installedTo);
      fs.mkdirSync(parentDir, { recursive: true });
      copyIntoPlace(src, installedTo, installSlug, parentDir);
      // Namespace the skill's own `name:` so it shows up prefixed in
      // the client's skills list, matching the folder name.
      prefixSkillFileName(path.join(installedTo, "SKILL.md"));
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
        installedTo: dest.skillPath,
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
  const env = opts.env ?? realEnv();
  const installSlug = withDragonbotPrefix(opts.slug);
  const destinations = resolveDestinations({
    slug: opts.slug,
    targets: opts.targets,
    dir: opts.dir,
    env,
  });
  const entries: UninstallEntry[] = [];
  for (const dest of destinations) {
    if (dest.entry?.customInstaller) {
      const result = dest.entry.customInstaller.uninstall({ env, slug: installSlug });
      entries.push({
        platform: dest.platform,
        label: dest.label,
        path: result.path,
        removed: result.removed,
      });
      continue;
    }
    const target = dest.skillPath;
    if (!fs.existsSync(target)) {
      entries.push({ platform: dest.platform, label: dest.label, path: target, removed: false });
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    entries.push({ platform: dest.platform, label: dest.label, path: target, removed: true });
  }
  return { slug: opts.slug, entries };
}

// Stage in a sibling tmp dir, then rename.
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
  }
}

/**
 * Read our own package.json's `version` field. Used as the
 * `plugin.json` version when installing into Cowork/Desktop plugin
 * bundles, so Cowork can see updates as we bump the CLI.
 */
function detectPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Re-exports so the CLI doesn't have to import from two modules. */
export {
  parsePlatformIds,
  detectAllPlatforms,
  getPlatform,
} from "./platforms.js";
