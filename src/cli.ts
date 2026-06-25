#!/usr/bin/env node
// @dragonbot-skills/cli — installer for DragonBot's Claude skills.
//
// Usage:
//   npx @dragonbot-skills/cli list
//   npx @dragonbot-skills/cli install <slug> [--project] [--target <dir>] [--force]
//   npx @dragonbot-skills/cli uninstall <slug> [--project] [--target <dir>]
//
// Keep the dispatch dumb on purpose — three commands, flat flag
// parsing, no commander/yargs dep. If we ever grow past ~5 commands,
// reach for one.

import { listBundledSkills } from "./skills.js";
import { install, uninstall, type Scope } from "./install.js";

const USAGE = `dragonbot-skills — install Claude skills from the DragonBot catalog

Usage:
  dragonbot-skills list
  dragonbot-skills install <slug> [--project] [--target <dir>] [--force]
  dragonbot-skills uninstall <slug> [--project] [--target <dir>]

Scope:
  (default)         install to ~/.claude/skills/<slug>/  (user-scope)
  --project         install to ./.claude/skills/<slug>/  (current repo only)
  --target <dir>    install to <dir>/<slug>/             (any custom path)

Flags:
  --force           overwrite an existing install
  -h, --help        show this help

Examples:
  dragonbot-skills install amazon-kw-research
  dragonbot-skills install amazon-kw-research --project --force
  dragonbot-skills list
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
    const padded = s.slug.padEnd(slugWidth, " ");
    process.stdout.write(`  ${padded}  ${s.description}\n`);
  }
  process.stdout.write(
    "\nInstall one with: dragonbot-skills install <slug>\n",
  );
  return 0;
}

function runInstall(rest: string[]): number {
  const { positionals, flags } = parseFlags(rest);
  const slug = positionals[0];
  if (!slug) {
    process.stderr.write("install: missing <slug>\n\n" + USAGE);
    return 2;
  }
  const scope: Scope = flags.project ? "project" : "user";
  try {
    const result = install({
      slug,
      scope,
      targetDir: flags.target,
      force: flags.force,
    });
    process.stdout.write(
      `✓ Installed ${slug} → ${result.installedTo} (${result.scope}-scope)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

function runUninstall(rest: string[]): number {
  const { positionals, flags } = parseFlags(rest);
  const slug = positionals[0];
  if (!slug) {
    process.stderr.write("uninstall: missing <slug>\n\n" + USAGE);
    return 2;
  }
  const scope: Scope = flags.project ? "project" : "user";
  try {
    const result = uninstall({
      slug,
      scope,
      targetDir: flags.target,
    });
    if (result.removed) {
      process.stdout.write(`✓ Removed ${slug} from ${result.path}\n`);
    } else {
      process.stdout.write(`(no-op) ${result.path} was not installed\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// Tiny flag parser: separates positionals from --foo / --foo=value /
// --foo value. Only the flags we actually use are typed.
type Flags = {
  project?: boolean;
  force?: boolean;
  target?: string;
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
      case "project":
        flags.project = true;
        break;
      case "force":
        flags.force = true;
        break;
      case "target":
        flags.target = inlineValue ?? args[++i];
        if (!flags.target) {
          throw new Error("--target needs a directory path");
        }
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }
  return { positionals, flags };
}

process.exit(main(process.argv));
