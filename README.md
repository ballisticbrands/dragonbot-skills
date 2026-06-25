# @dragonbot-skills/cli

Install [Claude skills](https://docs.anthropic.com/) from the DragonBot
catalog into your local Claude environment.

```bash
npx @dragonbot-skills/cli install amazon-kw-research
```

That single command drops `amazon-kw-research/SKILL.md` (plus any
references and scripts) into `~/.claude/skills/amazon-kw-research/`,
where Claude Code (and other Claude clients that follow the same
convention) will pick it up automatically.

## Commands

```bash
# What's in the catalog?
dragonbot-skills list

# Install a skill (user-scope: ~/.claude/skills/<slug>/)
dragonbot-skills install amazon-kw-research

# Install for one repo only (./.claude/skills/<slug>/)
dragonbot-skills install amazon-kw-research --project

# Install somewhere custom
dragonbot-skills install amazon-kw-research --target ~/my-claude-skills

# Reinstall over an existing copy
dragonbot-skills install amazon-kw-research --force

# Remove
dragonbot-skills uninstall amazon-kw-research
```

`-h` / `--help` prints the full usage.

## Skills

| Slug | What it does |
|---|---|
| `amazon-kw-research` | Amazon keyword research → workbook + PPC setup (uses Keepa + Jungle Scout via the DragonBot MCP). |

More skills will be added here — file a PR or run `dragonbot-skills list`
after upgrading.

## Where it installs

| Scope | Path | When to use |
|---|---|---|
| `user` *(default)* | `~/.claude/skills/<slug>/` | one install, every project on this machine sees it |
| `--project` | `<cwd>/.claude/skills/<slug>/` | this repo only |
| `--target <dir>` | `<dir>/<slug>/` | custom — for clients that use a different skills directory |

Skills installed here are picked up by Claude Code automatically. Other
Claude clients (Desktop, Cowork, etc.) that follow the `.claude/skills/`
convention work the same way; if yours reads from a different path, use
`--target`.

## Updating

Skills are bundled with this package, so updating is just `npx`-ing the
latest version:

```bash
npx @dragonbot-skills/cli@latest install amazon-kw-research --force
```

`--force` is needed because we won't silently overwrite an existing
install. (No, we don't auto-update — installs are explicit.)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/cli.js (chmod +x)
node dist/cli.js list
```

Skills live in `skills/<slug>/SKILL.md` at the package root. Adding a
new skill = adding a new folder there with a `SKILL.md` containing
frontmatter (`name:`, `description:`) and a markdown body. The
`bundledRoot` test override pattern in `src/install.test.ts` lets you
unit-test against synthetic skills without touching the real catalog.

## License

MIT — see [LICENSE](LICENSE).
