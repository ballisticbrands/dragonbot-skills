#!/usr/bin/env node
// @dragonbot-skills/cli — installer for DragonBot's Claude skills.
//
// Default install behavior: auto-detect every AI coding platform
// installed on this machine (Claude Code, Cursor, Codex, Copilot,
// Windsurf, ...) and drop the skill into each one. Match the
// "install once, works everywhere" UX from other skills hubs.
//
// Override with `--target claude-code,cursor` (specific platforms)
// or `--dir <path>` (raw directory).

import { listBundledSkills } from "./skills.js";
import {
  install,
  uninstall,
  resolveDestinations,
  parsePlatformIds,
  detectAllPlatforms,
} from "./install.js";
import { PLATFORM_REGISTRY, realEnv } from "./platforms.js";

const USAGE = `dragonbot-skills — install Claude skills from the DragonBot catalog

Usage:
  dragonbot-skills list
  dragonbot-skills list-platforms
  dragonbot-skills install <slug> [--target IDS] [--dir DIR] [--force] [--dry-run]
  dragonbot-skills uninstall <slug> [--target IDS] [--dir DIR]

Default behavior:
  install / uninstall auto-detects every installed AI coding platform
  (Claude Code, Cursor, Codex, Copilot, Windsurf, Cline, ...) and
  applies the action to ALL of them. Use --target or --dir to scope.

Flags:
  --target IDS    comma-separated platform ids (e.g. claude-code,cursor)
                  see \`list-platforms\` for the full set
  --dir DIR       install to <DIR>/<slug>/ instead of any detected
                  platform — useful for clients we don't recognize
  --force         overwrite an existing install
  --dry-run       show what install would do without writing anything
  -h, --help      show this help

Examples:
  dragonbot-skills install amazon-kw-research
  dragonbot-skills install amazon-kw-research --target claude-code,cursor
  dragonbot-skills install amazon-kw-research --dir ./.claude/skills
  dragonbot-skills install amazon-kw-research --dry-run
  dragonbot-skills list-platforms
`;

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "list":
      return runList();
    case "list-platforms":
      return runListPlatforms();
    case "install":
      return runInstall(rest);
    case "uninstall":
      return runUninstall(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function runList(): number {
  const skills = listBundledSkills();
  if (skills.length === 0) {
    process.stdout.write("No skills bundled in this version of the package.\n");
    return 0;
  }
  process.stdout.write(`Available skills (${skills.length}):\n\n`);
  const slugWidth = Math.max(...skills.map((s) => s.slug.length));
  for (const s of skills) {
    process.stdout.write(`  ${s.slug.padEnd(slugWidth, " ")}  ${s.description}\n`);
  }
  process.stdout.write("\nInstall one with: dragonbot-skills install <slug>\n");
  return 0;
}

function runListPlatforms(): number {
  const env = realEnv();
  const detected = new Set(detectAllPlatforms(env).map((p) => p.id));
  process.stdout.write("Supported platforms:\n\n");
  const idWidth = Math.max(...PLATFORM_REGISTRY.map((p) => p.id.length));
  for (const p of PLATFORM_REGISTRY) {
    const tag = detected.has(p.id) ? "✓ detected" : "  (not detected)";
    process.stdout.write(`  ${p.id.padEnd(idWidth, " ")}  ${tag}  ${p.label} → ${p.skillsRoot(env)}\n`);
  }
  process.stdout.write(
    "\nDefault install targets every detected platform. Override with " +
      "--target <id>[,<id>...] or --dir <path>.\n",
  );
  return 0;
}

function runInstall(rest: string[]): number {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(rest);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const { positionals, flags } = parsed;
  const slug = positionals[0];
  if (!slug) {
    process.stderr.write("install: missing <slug>\n\n" + USAGE);
    return 2;
  }
  if (flags.target && flags.dir) {
    process.stderr.write("install: --target and --dir are mutually exclusive\n");
    return 2;
  }

  // Resolve --target into known platforms; warn on typos before installing.
  let targets: ReturnType<typeof parsePlatformIds>["known"] | undefined;
  if (flags.target) {
    const { known, unknown } = parsePlatformIds(flags.target);
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown platform id(s): ${unknown.join(", ")}\n` +
          `Run \`dragonbot-skills list-platforms\` for the full set.\n`,
      );
      return 2;
    }
    targets = known;
  }

  // Preview the destinations before doing the work. If nothing was
  // detected and the user didn't override, explain it before
  // throwing — much nicer than a wall of text from the thrown error.
  const previewDests = resolveDestinations({ slug, targets, dir: flags.dir });
  if (previewDests.length === 0) {
    process.stderr.write(
      "No supported AI coding platforms were detected on this machine.\n" +
        "Pass --target <id> (see `dragonbot-skills list-platforms`) or " +
        "--dir <path> to install anyway.\n",
    );
    return 1;
  }

  try {
    const result = install({
      slug,
      targets,
      dir: flags.dir,
      force: flags.force,
      dryRun: flags.dryRun,
    });
    let installed = 0;
    let skipped = 0;
    let errored = 0;
    for (const entry of result.entries) {
      const tag =
        entry.status === "installed"
          ? "✓"
          : entry.status === "would-install"
            ? "·"
            : entry.status === "skipped-exists"
              ? "⊝"
              : "✗";
      const trailer = entry.reason ? ` (${entry.reason})` : "";
      process.stdout.write(
        `${tag} ${entry.label.padEnd(16)} → ${entry.installedTo}${trailer}\n`,
      );
      if (entry.status === "installed") installed++;
      else if (entry.status === "skipped-exists") skipped++;
      else if (entry.status === "error") errored++;
    }
    if (flags.dryRun) {
      process.stdout.write(`\n(dry run — nothing written)\n`);
      return 0;
    }
    const summary: string[] = [];
    if (installed) summary.push(`${installed} installed`);
    if (skipped) summary.push(`${skipped} skipped (use --force to overwrite)`);
    if (errored) summary.push(`${errored} failed`);
    process.stdout.write(`\n${summary.join(", ") || "no-op"}\n`);
    return errored > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

function runUninstall(rest: string[]): number {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(rest);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const { positionals, flags } = parsed;
  const slug = positionals[0];
  if (!slug) {
    process.stderr.write("uninstall: missing <slug>\n\n" + USAGE);
    return 2;
  }
  if (flags.target && flags.dir) {
    process.stderr.write("uninstall: --target and --dir are mutually exclusive\n");
    return 2;
  }

  let targets: ReturnType<typeof parsePlatformIds>["known"] | undefined;
  if (flags.target) {
    const { known, unknown } = parsePlatformIds(flags.target);
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown platform id(s): ${unknown.join(", ")}\n`,
      );
      return 2;
    }
    targets = known;
  }

  const result = uninstall({ slug, targets, dir: flags.dir });
  let removed = 0;
  for (const entry of result.entries) {
    if (entry.removed) {
      process.stdout.write(`✓ ${entry.label.padEnd(16)} → ${entry.path}\n`);
      removed++;
    } else {
      process.stdout.write(`· ${entry.label.padEnd(16)} → ${entry.path} (not installed)\n`);
    }
  }
  process.stdout.write(`\n${removed} removed\n`);
  return 0;
}

// ─── Flag parsing ──────────────────────────────────────────────────

type Flags = {
  target?: string;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
};

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq < 0 ? undefined : arg.slice(eq + 1);
    switch (key) {
      case "force":
        flags.force = true;
        break;
      case "dry-run":
        flags.dryRun = true;
        break;
      case "target":
        flags.target = inlineValue ?? args[++i];
        if (!flags.target) throw new Error("--target needs a value");
        break;
      case "dir":
        flags.dir = inlineValue ?? args[++i];
        if (!flags.dir) throw new Error("--dir needs a directory path");
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }
  return { positionals, flags };
}

process.exit(main(process.argv));
