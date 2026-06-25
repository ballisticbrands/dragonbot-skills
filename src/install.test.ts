// Unit tests for the install/uninstall flow + platform detection.

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

// ─── Platform detection ────────────────────────────────────────────

test("detectAllPlatforms returns empty when no client config dirs exist", () => {
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const detected = detectAllPlatforms({ home, cwd });
  assert.deepEqual(detected, []);
});

test("detectAllPlatforms finds claude-code when ~/.claude exists", () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const detected = detectAllPlatforms({ home, cwd });
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.id, "claude-code");
});

test("detectAllPlatforms finds every installed client", () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.mkdirSync(path.join(home, ".codex"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const ids = detectAllPlatforms({ home, cwd }).map((p) => p.id);
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("cursor"));
  assert.ok(ids.includes("codex"));
});

test("detectAllPlatforms finds cwd-based clients (copilot via .github/copilot)", () => {
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  fs.mkdirSync(path.join(cwd, ".github", "copilot"), { recursive: true });
  const ids = detectAllPlatforms({ home, cwd }).map((p) => p.id);
  assert.ok(ids.includes("copilot"));
});

test("parsePlatformIds separates known from unknown", () => {
  const { known, unknown } = parsePlatformIds("claude-code,unknown-thing,cursor");
  assert.deepEqual(known.map((p) => p.id), ["claude-code", "cursor"]);
  assert.deepEqual(unknown, ["unknown-thing"]);
});

test("every PLATFORM_REGISTRY entry has a consistent id + path + detect", () => {
  for (const entry of PLATFORM_REGISTRY) {
    assert.ok(ALL_PLATFORM_IDS.includes(entry.id));
    assert.equal(getPlatform(entry.id), entry);
    assert.equal(typeof entry.path, "function");
    assert.equal(typeof entry.detect, "function");
    assert.ok(entry.label.length > 0);
  }
});

// ─── resolveDestinations ───────────────────────────────────────────

test("resolveDestinations: --dir overrides everything", () => {
  const dests = resolveDestinations({ dir: "/custom/path" });
  assert.equal(dests.length, 1);
  assert.equal(dests[0]!.platform, "custom");
  assert.equal(dests[0]!.root, "/custom/path");
});

test("resolveDestinations: explicit targets resolve to their platform paths", () => {
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const targets = [getPlatform("claude-code")!, getPlatform("cursor")!];
  const dests = resolveDestinations({ targets, env: { home, cwd } });
  assert.equal(dests.length, 2);
  assert.equal(dests[0]!.root, path.join(home, ".claude", "skills"));
  assert.equal(dests[1]!.root, path.join(home, ".cursor", "skills"));
});

test("resolveDestinations: no targets + no dir → auto-detect", () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const dests = resolveDestinations({ env: { home, cwd } });
  assert.deepEqual(
    dests.map((d) => d.platform).sort(),
    ["claude-code", "cursor"],
  );
});

// ─── install ───────────────────────────────────────────────────────

test("install: writes to every detected platform by default", () => {
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

  const result = install({
    slug: "amazon-kw-research",
    targets: [getPlatform("claude-code")!],
    bundledRoot: bundled,
    env: { home, cwd },
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.platform, "claude-code");
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "amazon-kw-research", "SKILL.md")));
  // cursor must NOT have been touched.
  assert.ok(!fs.existsSync(path.join(home, ".cursor", "skills", "amazon-kw-research")));
});

test("install: --dir routes to a raw directory regardless of detection", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-custom-"));

  const result = install({
    slug: "amazon-kw-research",
    dir: customDir,
    bundledRoot: bundled,
    env: { home, cwd },
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.platform, "custom");
  assert.ok(fs.existsSync(path.join(customDir, "amazon-kw-research", "SKILL.md")));
});

test("install: --dry-run returns would-install entries without writing", () => {
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

test("install: existing destination → skipped-exists without --force", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const second = install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  assert.equal(second.entries[0]!.status, "skipped-exists");
});

test("install: --force overwrites an existing install (and wipes stale files)", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const installed = path.join(home, ".claude", "skills", "amazon-kw-research");
  fs.writeFileSync(path.join(installed, "stale.txt"), "stale");

  const second = install({
    slug: "amazon-kw-research",
    bundledRoot: bundled,
    env: { home, cwd },
    force: true,
  });
  assert.equal(second.entries[0]!.status, "installed");
  assert.ok(!fs.existsSync(path.join(installed, "stale.txt")));
  assert.ok(fs.existsSync(path.join(installed, "SKILL.md")));
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

test("install: throws with a helpful message when no platforms are detected and no override", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  assert.throws(
    () => install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } }),
    /No install destinations resolved/,
  );
});

// ─── uninstall ─────────────────────────────────────────────────────

test("uninstall: removes from every detected platform that has the skill", () => {
  const bundled = mkBundledRoot({ "amazon-kw-research/SKILL.md": SAMPLE_SKILL });
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".cursor"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));

  install({ slug: "amazon-kw-research", bundledRoot: bundled, env: { home, cwd } });
  const result = uninstall({ slug: "amazon-kw-research", env: { home, cwd } });
  const removed = result.entries.filter((e) => e.removed);
  assert.equal(removed.length, 2);
  for (const e of removed) {
    assert.ok(!fs.existsSync(e.path));
  }
});

test("uninstall: no-op entries when the skill wasn't installed on that platform", () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbskills-cwd-"));
  const result = uninstall({ slug: "ghost", env: { home, cwd } });
  assert.equal(result.entries[0]!.removed, false);
});

// ─── bundled catalog sanity check ──────────────────────────────────
// Real bundled `skills/` must contain amazon-kw-research with valid
// frontmatter. The only test that touches the actual package payload.

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
