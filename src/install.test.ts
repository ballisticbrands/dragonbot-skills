// Unit tests for the install/uninstall flow + platform detection
// + Cowork/Desktop plugin-bundle installer.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { install, uninstall, resolveDestinations } from "./install.js";
import {
  PLATFORM_REGISTRY,
  ALL_PLATFORM_IDS,
  detectAllPlatforms,
  parsePlatformIds,
  getPlatform,
} from "./platforms.js";
import { listBundledSkills, findBundledSkill } from "./skills.js";
import {
  bundleDir,
  appPluginRoot,
  DRAGONBOT_PLUGIN_UUID,
  DRAGONBOT_SNAPSHOT_UUID,
  PLUGIN_NAME,
} from "./cowork-plugin.js";

const SAMPLE_SKILL = `---
name: amazon-keyword-research
description: Amazon keyword research for product listings and PPC.
---

# Body
`;

function mkBundledRoot(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-bundled-"));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function mkTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-home-"));
}

function makeCoworkDir(home: string, app: "Claude" | "Claude-Work"): void {
  // Cowork/Desktop detect on the parent skills-plugin dir's existence.
  fs.mkdirSync(
    path.join(home, "Library", "Application Support", app,
      "local-agent-mode-sessions", "skills-plugin"),
    { recursive: true },
  );
}

// ─── Platform detection ────────────────────────────────────────────

test("detectAllPlatforms returns empty when no client config dirs exist", () => {
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  assert.deepEqual(detectAllPlatforms({ home, cwd }), []);
});

test("detectAllPlatforms finds claude-code when ~/.claude exists", () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const ids = detectAllPlatforms({ home, cwd }).map((p) => p.id);
  assert.deepEqual(ids, ["claude-code"]);
});

test("detectAllPlatforms finds cowork when its plugin dir exists", () => {
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const ids = detectAllPlatforms({ home, cwd }).map((p) => p.id);
  assert.ok(ids.includes("cowork"));
});

test("detectAllPlatforms finds claude-desktop separately from cowork", () => {
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const ids = detectAllPlatforms({ home, cwd }).map((p) => p.id);
  assert.ok(ids.includes("claude-desktop"));
  assert.ok(!ids.includes("cowork"));
});

test("parsePlatformIds separates known from unknown", () => {
  const { known, unknown } = parsePlatformIds("claude-code,cowork,unknown-thing");
  assert.deepEqual(known.map((p) => p.id), ["claude-code", "cowork"]);
  assert.deepEqual(unknown, ["unknown-thing"]);
});

test("every PLATFORM_REGISTRY entry is consistent", () => {
  for (const entry of PLATFORM_REGISTRY) {
    assert.ok(ALL_PLATFORM_IDS.includes(entry.id));
    assert.equal(getPlatform(entry.id), entry);
    assert.equal(typeof entry.skillsRoot, "function");
    assert.equal(typeof entry.detect, "function");
    assert.ok(entry.label.length > 0);
  }
});

// ─── resolveDestinations ───────────────────────────────────────────

test("resolveDestinations: --dir routes to <dir>/<slug>", () => {
  const dests = resolveDestinations({ slug: "amazon-kw-research", dir: "/custom" });
  assert.equal(dests.length, 1);
  assert.equal(dests[0]!.platform, "custom");
  assert.equal(dests[0]!.skillPath, path.join("/custom", "amazon-kw-research"));
});

test("resolveDestinations: explicit targets resolve to <skillsRoot>/<slug>", () => {
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const dests = resolveDestinations({
    slug: "amazon-kw-research",
    targets: [getPlatform("claude-code")!, getPlatform("cursor")!],
    env: { home, cwd },
  });
  assert.deepEqual(
    dests.map((d) => d.skillPath),
    [
      path.join(home, ".claude", "skills", "amazon-kw-research"),
      path.join(home, ".cursor", "skills", "amazon-kw-research"),
    ],
  );
});

// ─── install (standard platforms) ──────────────────────────────────

test("install: writes to every detected standard platform by default", () => {
  const bundled = mkBundledRoot({
    "amazon-kw-research/SKILL.md": SAMPLE_SKILL,
    "amazon-kw-research/references/foo.md": "ref",
  });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  const result = install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    env: { home, cwd },
  });
  const installed = result.entries.filter((e) => e.status === "installed");
  assert.equal(installed.length, 2);
  for (const e of installed) {
    assert.ok(fs.existsSync(path.join(e.installedTo, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(e.installedTo, "references", "foo.md")));
  }
});

test("install: --target scopes to listed platforms only", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({
    slug: "amazon-kw-research",
    targets: [getPlatform("claude-code")!],
    bundledRoot: bundled,
    env: { home, cwd },
  });
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "amazon-kw-research", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(home, ".cursor", "skills", "amazon-kw-research")));
});

test("install: --dir routes to a raw directory", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-custom-"));

  install({
    slug: "amazon-kw-research",
    dir: customDir,
    bundledRoot: bundled,
    env: { home, cwd },
  });
  assert.ok(fs.existsSync(path.join(customDir, "amazon-kw-research", "SKILL.md")));
});

test("install: existing destination → skipped-exists without --force", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const second = install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  assert.equal(second.entries[0]!.status, "skipped-exists");
});

test("install: --force overwrites and wipes stale files", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const installed = path.join(home, ".claude", "skills", "amazon-kw-research");
  fs.writeFileSync(path.join(installed, "stale.txt"), "stale");

  install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    env: { home, cwd },
    force: true,
  });
  assert.ok(!fs.existsSync(path.join(installed, "stale.txt")));
  assert.ok(fs.existsSync(path.join(installed, "SKILL.md")));
});

test("install: --dry-run reports would-install entries, writes nothing", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  const result = install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    env: { home, cwd },
    dryRun: true,
  });
  assert.equal(result.entries[0]!.status, "would-install");
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills", "amazon-kw-research")));
});

test("install: throws helpfully when no platforms are detected", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  assert.throws(
    () => install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } }),
    /No install destinations resolved/,
  );
});

test("install: throws when slug is not bundled", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  assert.throws(
    () => install({ slug: "ghost", bundledRoot: bundled, env: { home, cwd } }),
    /Skill not found/,
  );
});

// ─── install (Cowork plugin bundle) ────────────────────────────────

test("install (cowork): writes plugin.json + manifest.json + skills/<slug>/", () => {
  const bundled = mkBundledRoot({
    "amazon-kw-research/SKILL.md": SAMPLE_SKILL,
    "amazon-kw-research/references/foo.md": "ref",
  });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  const result = install({
    slug: "amazon-kw-research",
    targets: [getPlatform("cowork")!],
    bundledRoot: bundled,
    env: { home, cwd },
    packageVersion: "0.3.0",
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.status, "installed");

  const dir = bundleDir("cowork", { home, cwd });
  assert.match(dir, new RegExp(`${DRAGONBOT_PLUGIN_UUID}/${DRAGONBOT_SNAPSHOT_UUID}$`));

  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(pluginJson.name, PLUGIN_NAME);
  assert.equal(pluginJson.version, "0.3.0");

  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.skills.length, 1);
  assert.equal(manifest.skills[0]!.skillId, "amazon-kw-research");
  assert.equal(manifest.skills[0]!.creatorType, "third-party");
  assert.equal(manifest.skills[0]!.enabled, true);
  assert.ok(typeof manifest.lastUpdated === "number");

  assert.ok(fs.existsSync(path.join(dir, "skills", "amazon-kw-research", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, "skills", "amazon-kw-research", "references", "foo.md")));
});

test("install (cowork): a second install merges into the manifest, doesn't overwrite", () => {
  const bundled = mkBundledRoot({
    "skill-one/SKILL.md": `---\nname: skill-one\ndescription: First.\n---\nA\n`,
    "skill-two/SKILL.md": `---\nname: skill-two\ndescription: Second.\n---\nB\n`,
  });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({
    slug: "skill-one",
    targets: [getPlatform("cowork")!],
    bundledRoot: bundled,
    env: { home, cwd },
  });
  install({
    slug: "skill-two",
    targets: [getPlatform("cowork")!],
    bundledRoot: bundled,
    env: { home, cwd },
  });

  const dir = bundleDir("cowork", { home, cwd });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.skills.length, 2);
  const ids = manifest.skills.map((s: { skillId: string }) => s.skillId).sort();
  assert.deepEqual(ids, ["skill-one", "skill-two"]);
  // Both skill folders survived.
  assert.ok(fs.existsSync(path.join(dir, "skills", "skill-one", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, "skills", "skill-two", "SKILL.md")));
});

test("install (cowork): --force replaces, --without-force skips an existing skill", () => {
  const bundled = mkBundledRoot({ "skill-one/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "skill-one", targets: [getPlatform("cowork")!], bundledRoot: bundled, env: { home, cwd } });
  const second = install({
    slug: "skill-one",
    targets: [getPlatform("cowork")!],
    bundledRoot: bundled,
    env: { home, cwd },
  });
  assert.equal(second.entries[0]!.status, "skipped-exists");

  const third = install({
    slug: "skill-one",
    targets: [getPlatform("cowork")!],
    bundledRoot: bundled,
    env: { home, cwd },
    force: true,
  });
  assert.equal(third.entries[0]!.status, "installed");
});

test("install (cowork): auto-detects both Claude Desktop and Cowork", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude");
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  const result = install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    env: { home, cwd },
  });
  const installedPlatforms = result.entries
    .filter((e) => e.status === "installed")
    .map((e) => e.platform);
  assert.ok(installedPlatforms.includes("claude-desktop"));
  assert.ok(installedPlatforms.includes("cowork"));
  // Both bundle dirs exist.
  assert.ok(fs.existsSync(appPluginRoot("claude-desktop", { home, cwd })));
  assert.ok(fs.existsSync(appPluginRoot("cowork", { home, cwd })));
});

// ─── uninstall ─────────────────────────────────────────────────────

test("uninstall: removes from every detected standard platform", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const result = uninstall({ slug: "amazon-kw-research", env: { home, cwd } });
  assert.equal(result.entries.filter((e) => e.removed).length, 2);
});

test("uninstall (cowork): drops the skill from manifest + removes folder", () => {
  const bundled = mkBundledRoot({
    "skill-one/SKILL.md": `---\nname: skill-one\ndescription: First.\n---\nA\n`,
    "skill-two/SKILL.md": `---\nname: skill-two\ndescription: Second.\n---\nB\n`,
  });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "skill-one", targets: [getPlatform("cowork")!], bundledRoot: bundled, env: { home, cwd } });
  install({ slug: "skill-two", targets: [getPlatform("cowork")!], bundledRoot: bundled, env: { home, cwd } });

  const result = uninstall({
    slug: "skill-one",
    targets: [getPlatform("cowork")!],
    env: { home, cwd },
  });
  assert.equal(result.entries[0]!.removed, true);

  const dir = bundleDir("cowork", { home, cwd });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.skills.map((s: { skillId: string }) => s.skillId), ["skill-two"]);
  assert.ok(!fs.existsSync(path.join(dir, "skills", "skill-one")));
  assert.ok(fs.existsSync(path.join(dir, "skills", "skill-two")));
});

test("uninstall (cowork): removes the entire plugin dir when last skill is gone", () => {
  const bundled = mkBundledRoot({ "skill-one/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  makeCoworkDir(home, "Claude-Work");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "skill-one", targets: [getPlatform("cowork")!], bundledRoot: bundled, env: { home, cwd } });
  uninstall({ slug: "skill-one", targets: [getPlatform("cowork")!], env: { home, cwd } });

  const dir = bundleDir("cowork", { home, cwd });
  assert.ok(!fs.existsSync(dir), "empty bundle dir should be removed");
});

// ─── bundled catalog sanity check ──────────────────────────────────

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
