// Install / uninstall skills into the user's local Claude skills
// directory.
//
// Claude Code reads skills from two locations:
//   user-scope    ~/.claude/skills/<slug>/SKILL.md
//   project-scope <cwd>/.claude/skills/<slug>/SKILL.md
//
// We default to user-scope (one install, every project sees it) and
// expose `--project` for the per-repo variant. `--target <dir>`
// overrides both — useful for other Claude clients (Cowork, Desktop)
// that put their skills directory somewhere else.
//
// Install is atomic-ish: copy to a temp directory next to the
// destination, then rename into place. If the destination already
// exists we refuse without `--force` — a real reinstall should be
// explicit, not silent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findBundledSkill } from "./skills.js";

export type Scope = "user" | "project";

export type InstallOpts = {
  slug: string;
  scope?: Scope;       // default "user"
  targetDir?: string;  // overrides scope (raw skills/ root path)
  force?: boolean;     // overwrite existing install
  cwd?: string;        // for tests; defaults to process.cwd()
  home?: string;       // for tests; defaults to os.homedir()
  bundledRoot?: string; // for tests; defaults to bundled skills/ in the package
};

export type InstallResult = {
  installedTo: string; // absolute path to <skills-root>/<slug>/
  scope: Scope | "custom";
};

/**
 * Resolve the skills directory the CLI should write into for a
 * given scope. Doesn't create the directory — install() does that.
 */
export function resolveSkillsRoot(opts: {
  scope?: Scope;
  targetDir?: string;
  cwd?: string;
  home?: string;
}): { root: string; scope: Scope | "custom" } {
  if (opts.targetDir) {
    return { root: path.resolve(opts.targetDir), scope: "custom" };
  }
  const scope = opts.scope ?? "user";
  if (scope === "project") {
    const cwd = opts.cwd ?? process.cwd();
    return { root: path.join(cwd, ".claude", "skills"), scope: "project" };
  }
  const home = opts.home ?? os.homedir();
  return { root: path.join(home, ".claude", "skills"), scope: "user" };
}

/**
 * Copy the bundled skill folder for `slug` into the chosen skills
 * directory. Throws when:
 *   - the slug isn't bundled in this package
 *   - the destination exists and `force` is false
 */
export function install(opts: InstallOpts): InstallResult {
  const src = findBundledSkill(opts.slug, opts.bundledRoot);
  if (!src) {
    throw new Error(
      `Skill not found in this package: ${opts.slug}\n` +
        `Run \`dragonbot-skills list\` to see what's available.`,
    );
  }

  const { root, scope } = resolveSkillsRoot({
    scope: opts.scope,
    targetDir: opts.targetDir,
    cwd: opts.cwd,
    home: opts.home,
  });
  const dest = path.join(root, opts.slug);

  if (fs.existsSync(dest)) {
    if (!opts.force) {
      throw new Error(
        `${dest} already exists. Pass --force to overwrite.`,
      );
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(root, { recursive: true });

  // Stage in a sibling tmp dir, then rename. Avoids leaving a half-
  // copied skill folder behind if the copy is interrupted.
  const staging = fs.mkdtempSync(path.join(root, `.${opts.slug}-staging-`));
  try {
    copyDirRecursive(src, staging);
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  return { installedTo: dest, scope };
}

export type UninstallOpts = {
  slug: string;
  scope?: Scope;
  targetDir?: string;
  cwd?: string;
  home?: string;
};

export type UninstallResult = {
  removed: boolean;     // false if nothing was there to begin with
  path: string;
  scope: Scope | "custom";
};

/**
 * Remove the installed skill folder. Idempotent: returns
 * `removed: false` (no error) when the folder isn't present.
 */
export function uninstall(opts: UninstallOpts): UninstallResult {
  const { root, scope } = resolveSkillsRoot({
    scope: opts.scope,
    targetDir: opts.targetDir,
    cwd: opts.cwd,
    home: opts.home,
  });
  const dest = path.join(root, opts.slug);
  if (!fs.existsSync(dest)) {
    return { removed: false, path: dest, scope };
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { removed: true, path: dest, scope };
}

// Minimal recursive copy — no externals, follows directories and
// regular files only. Symlinks aren't expected in skills today; if
// we ever ship one, switch to fs.cp({ recursive: true, verbatimSymlinks: true }).
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
