// Unit tests for the install/uninstall flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { install, uninstall, resolveSkillsRoot } from "./install.js";
import { listBundledSkills, findBundledSkill } from "./skills.js";

const SAMPLE_SKILL = `---
name: amazon-keyword-research
description: Amazon keyword research for product listings and PPC.
---

# Amazon Keyword Research Skill
Body.
`;

function mkBundledRoot(layout: Record<string, string>): string {
  // layout keys are "<slug>/<relative-path>". Write each as a file
  // under a fresh temp dir. Returns that dir — used as `bundledRoot`
  // override on install() / findBundledSkill() so we don't depend
  // on the package's real bundled catalog in unit tests.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-bundled-"));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dbskills-${prefix}-`));
}

// ─── resolveSkillsRoot ─────────────────────────────────────────────

test("resolveSkillsRoot defaults to user scope at ~/.claude/skills", () => {
  const r = resolveSkillsRoot({ home: "/h", cwd: "/c" });
  assert.equal(r.scope, "user");
  assert.equal(r.root, path.join("/h", ".claude", "skills"));
});

test("resolveSkillsRoot honors --project (./.claude/skills under cwd)", () => {
  const r = resolveSkillsRoot({ scope: "project", home: "/h", cwd: "/c" });
  assert.equal(r.scope, "project");
  assert.equal(r.root, path.join("/c", ".claude", "skills"));
});

test("resolveSkillsRoot --target overrides scope and resolves to absolute", () => {
  const r = resolveSkillsRoot({ targetDir: "/custom/path", home: "/h", cwd: "/c" });
  assert.equal(r.scope, "custom");
  assert.equal(r.root, "/custom/path");
});

// ─── install ───────────────────────────────────────────────────────

test("install copies the bundled skill folder to the chosen scope", () => {
  const bundled = mkBundledRoot({
    "amazon-kw-research/SKILL.md": SAMPLE_SKILL,
    "amazon-kw-research/references/foo.md": "ref",
    "amazon-kw-research/scripts/run.sh": "#!/bin/sh\necho hi\n",
  });
  const home = mkTmpDir("home");

  const result = install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    home,
  });

  assert.equal(result.scope, "user");
  assert.equal(
    result.installedTo,
    path.join(home, ".claude", "skills", "amazon-kw-research"),
  );
  assert.ok(fs.existsSync(path.join(result.installedTo, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(result.installedTo, "references", "foo.md")));
  assert.ok(fs.existsSync(path.join(result.installedTo, "scripts", "run.sh")));
  assert.equal(
    fs.readFileSync(path.join(result.installedTo, "SKILL.md"), "utf8"),
    SAMPLE_SKILL,
  );
});

test("install --project writes to <cwd>/.claude/skills/<slug>", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const cwd = mkTmpDir("cwd");

  const result = install({
    slug: "amazon-kw-research",
    scope: "project",
    bundledRoot: bundled,
    cwd,
  });

  assert.equal(result.scope, "project");
  assert.equal(
    result.installedTo,
    path.join(cwd, ".claude", "skills", "amazon-kw-research"),
  );
});

test("install --target writes directly under the given directory", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const target = mkTmpDir("target");

  const result = install({
    slug: "amazon-kw-research",
    targetDir: target,
    bundledRoot: bundled,
  });

  assert.equal(result.scope, "custom");
  assert.equal(result.installedTo, path.join(target, "amazon-kw-research"));
});

test("install refuses to overwrite an existing install without --force", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpDir("home");

  install({ slug: "amazon-kw-research", bundledRoot: bundled, home });
  assert.throws(
    () => install({ slug: "amazon-kw-research", bundledRoot: bundled, home }),
    /already exists.*--force/,
  );
});

test("install --force replaces an existing install", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpDir("home");

  install({ slug: "amazon-kw-research", bundledRoot: bundled, home });
  // Put a stray file in the existing dir — should NOT survive --force.
  const dest = path.join(home, ".claude", "skills", "amazon-kw-research");
  fs.writeFileSync(path.join(dest, "stale.txt"), "stale");

  install({ slug: "amazon-kw-research", bundledRoot: bundled, home, force: true });
  assert.ok(!fs.existsSync(path.join(dest, "stale.txt")));
  assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));
});

test("install throws when the slug is not bundled", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpDir("home");
  assert.throws(
    () => install({ slug: "ghost-skill", bundledRoot: bundled, home }),
    /Skill not found/,
  );
});

// ─── uninstall ─────────────────────────────────────────────────────

test("uninstall removes a previously-installed skill", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpDir("home");

  install({ slug: "amazon-kw-research", bundledRoot: bundled, home });
  const result = uninstall({ slug: "amazon-kw-research", home });

  assert.equal(result.removed, true);
  assert.ok(!fs.existsSync(result.path));
});

test("uninstall is a no-op when nothing is installed", () => {
  const home = mkTmpDir("home");
  const result = uninstall({ slug: "ghost", home });
  assert.equal(result.removed, false);
});

// ─── bundled catalog sanity check ──────────────────────────────────
// Real bundled `skills/` must contain amazon-kw-research with valid
// frontmatter. This is the only test that touches the actual package
// payload — if you rename or remove the skill, this fails loudly.

test("the bundled catalog contains amazon-kw-research", () => {
  const skills = listBundledSkills();
  const kw = skills.find((s) => s.slug === "amazon-kw-research");
  assert.ok(kw, "expected skills/amazon-kw-research/SKILL.md in the package");
  assert.ok(kw.name.length > 0);
  assert.ok(kw.description.length > 0);

  const dir = findBundledSkill("amazon-kw-research");
  assert.ok(dir);
  assert.ok(fs.existsSync(path.join(dir, "SKILL.md")));
});
