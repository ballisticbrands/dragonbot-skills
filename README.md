# @dragonbot-skills/cli

Install Claude skills from the DragonBot catalog into every AI coding
tool you use, with one command:

```bash
npx @dragonbot-skills/cli install amazon-kw-research
```

That auto-detects every AI coding platform installed on your machine
(Claude Code, Cursor, Codex CLI, GitHub Copilot, Windsurf, Cline,
OpenCode, Continue, Gemini CLI, Roo, Zed) and drops the skill folder
into each one's skills directory. Install once, available everywhere.

You install by the bare catalog slug (`amazon-kw-research`), but every
skill lands **namespaced with a `dragonbot-` prefix** — the example
above installs `dragonbot-amazon-kw-research` (folder and skill name),
so DragonBot skills are easy to spot and never collide with same-named
skills from elsewhere. Already-prefixed slugs aren't doubled.

Prefer a browser? The catalog is also published as a static site (one
page per skill, with the copy-paste install line and a ZIP download
for the Claude desktop/web apps). Build it with `npm run build:web`
(output in `web/dist/`); it deploys to GitHub Pages on every push to
`main`.

## Commands

```bash
# What skills are in the catalog?
dragonbot-skills list

# What platforms am I targeting?
dragonbot-skills list-platforms

# Install (auto-detects every supported platform)
dragonbot-skills install amazon-kw-research

# Scope to specific platforms
dragonbot-skills install amazon-kw-research --target claude-code,cursor

# Install to a raw directory (useful for clients we don't recognize yet)
dragonbot-skills install amazon-kw-research --dir ./.claude/skills

# Preview what would happen, write nothing
dragonbot-skills install amazon-kw-research --dry-run

# Reinstall over an existing copy
dragonbot-skills install amazon-kw-research --force

# Remove (also multi-platform by default)
dragonbot-skills uninstall amazon-kw-research
```

`-h` / `--help` prints the full usage.

## Skills

| Slug | What it does |
|---|---|
| `amazon-kw-research` | Amazon keyword research → workbook + PPC setup (uses Keepa + Jungle Scout via the DragonBot MCP). |

Catalog grows over time — run `dragonbot-skills list` after upgrading.

## Where it installs

Default behavior: install to **every detected platform**. The registry:

| Platform id | Install path | Detected by |
|---|---|---|
| `claude-code` | `~/.claude/skills/<slug>/` | `~/.claude` exists |
| `claude-desktop` | Claude Desktop plugin bundle (see below) | `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin` exists |
| `cowork` | Claude Cowork plugin bundle (see below) | `~/Library/Application Support/Claude-Work/local-agent-mode-sessions/skills-plugin` exists |
| `cursor` | `~/.cursor/skills/<slug>/` | `~/.cursor` exists |
| `codex` | `~/.codex/skills/<slug>/` | `~/.codex` exists |
| `copilot` | `<cwd>/.github/copilot/skills/<slug>/` | `.github/copilot/` or `.github/copilot-instructions.md` |
| `windsurf` | `~/.windsurf/skills/<slug>/` | `~/.windsurf` or `.windsurfrules` |
| `cline` | `~/.cline/skills/<slug>/` | `~/.cline` or `.clinerules` |
| `opencode` | `~/.opencode/skills/<slug>/` | `~/.opencode` exists |
| `continue` | `~/.continue/skills/<slug>/` | `~/.continue` exists |
| `gemini` | `~/.gemini/skills/<slug>/` | `~/.gemini` exists |
| `roo` | `~/.roo/skills/<slug>/` | `~/.roo` or `.roorules` |
| `zed` | `~/Library/Application Support/Zed/skills/<slug>/` (macOS) | parent dir exists |

Some paths are best-effort (the platform hasn't documented a canonical
skills directory). They're marked in the source — open an issue if
you know better.

### Cowork / Claude Desktop plugin bundle

Cowork and Claude Desktop don't read from `~/.claude/skills/`. They
load skills as **plugin bundles** at:

```
~/Library/Application Support/<App>/local-agent-mode-sessions/skills-plugin/
  <plugin-uuid>/<snapshot-uuid>/
    .claude-plugin/plugin.json   { name, version, description }
    manifest.json                 { lastUpdated, skills: [...] }
    skills/<slug>/SKILL.md        (+ nested files)
```

We ship all our skills as a single bundle named `dragonbot-skills`.
The plugin + snapshot UUIDs are hardcoded so reinstalls + the
manifest merge always land in the same place. Installing skill
`<slug>`:
- creates the bundle dir if missing
- (re)writes `plugin.json` with the current CLI version
- merges the skill's entry into `manifest.json` (`creatorType: "third-party"`, `enabled: true`)
- copies the skill folder into `skills/<slug>/`

Best-effort caveat: Cowork's plugin layout is reverse-engineered
from its bundled `anthropic-skills` plugin. Cowork may need a
restart to pick up newly-installed skills, and an in-app
resync/update could in theory overwrite the bundle. If you hit a
case where it doesn't load, file an issue.

Run `dragonbot-skills list-platforms` on your machine to see what's
detected and where each install would land.

## Updating

Skills are bundled with this package, so upgrading is just re-running
`npx` with `@latest`:

```bash
npx @dragonbot-skills/cli@latest install amazon-kw-research --force
```

`--force` is needed because we won't silently overwrite an existing
install.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/cli.js (chmod +x)
node dist/cli.js list-platforms
```

Skills live in `skills/<slug>/SKILL.md` at the package root. Adding a
new skill = adding a folder there with a `SKILL.md` containing
frontmatter (`name:`, `description:`) and a markdown body. The
`bundledRoot` test override pattern in `src/install.test.ts` lets you
unit-test against synthetic skills without touching the real catalog.

## Credits

The auto-detect-and-install-everywhere pattern is adapted from
[skills-hub.ai](https://skills-hub.ai)'s
[@skills-hub-ai/cli](https://www.npmjs.com/package/@skills-hub-ai/cli)
(MIT). They pioneered this UX for Claude-style skills.

## License

MIT — see [LICENSE](LICENSE).
