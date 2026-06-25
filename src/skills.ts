// Discovery of skills bundled inside this package.
//
// The CLI doesn't fetch from a registry yet — every skill we
// distribute lives under `skills/<slug>/` inside the package itself.
// `npm install`-ing @dragonbot-skills/cli (or running it via npx)
// gives the user the full catalog locally; the install command just
// copies the requested folder out to the user's Claude skills dir.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
};

/**
 * Absolute path to the bundled `skills/` directory.
 *
 * Resolves relative to THIS source file, not to process.cwd() —
 * users run `npx @dragonbot-skills/cli` from wherever they happen
 * to be, so cwd is irrelevant. We walk up from `dist/skills.js`
 * (compiled) to the package root and then into `skills/`.
 */
export function bundledSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "skills");
}

/**
 * Return every skill bundled in this package: the directory name
 * (slug) plus the `name:` and `description:` fields parsed from its
 * SKILL.md frontmatter. Sorted by slug for stable output.
 *
 * Skips any subdirectory that doesn't contain a SKILL.md (it's not
 * a skill).
 */
export function listBundledSkills(rootOverride?: string): SkillSummary[] {
  const dir = rootOverride ?? bundledSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillFile = path.join(dir, slug, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const body = fs.readFileSync(skillFile, "utf8");
    const meta = parseFrontmatter(body);
    skills.push({
      slug,
      name: meta.name ?? slug,
      description: meta.description ?? "",
    });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

/**
 * Resolve the on-disk path of a single bundled skill folder.
 * Returns null when the slug isn't present (or the folder lacks a
 * SKILL.md, in which case it isn't really a skill).
 */
export function findBundledSkill(slug: string, rootOverride?: string): string | null {
  const root = rootOverride ?? bundledSkillsDir();
  const dir = path.join(root, slug);
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return null;
  return dir;
}

// ─── Tiny frontmatter parser ───────────────────────────────────────
// Pulls the flat-scalar fields we need (`name:`, `description:`).
// Nested keys (`requires:` → ...) are skipped — full YAML would be
// overkill just to extract two strings.

type Frontmatter = {
  name?: string;
  description?: string;
};

function parseFrontmatter(source: string): Frontmatter {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end < 0) return {};
  const header = source.slice(3, end).trim();

  const out: Frontmatter = {};
  for (const rawLine of header.split("\n")) {
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}
