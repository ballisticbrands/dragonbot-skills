#!/usr/bin/env node
// Static site generator for the DragonBot skills catalog.
//
// Reads every skill under `skills/<slug>/SKILL.md`, then emits a
// self-contained static site into `web/dist/`:
//
//   dist/index.html            — browse all skills
//   dist/skills/<slug>.html    — one page per skill (description,
//                                npx install line, zip download,
//                                rendered SKILL.md body)
//   dist/zips/<slug>.zip       — the skill folder, zipped with the
//                                folder as the archive root (the shape
//                                Claude's "Upload a skill" expects)
//   dist/styles.css            — shared styles
//
// No build dependencies: Node built-ins + the system `zip` binary.
// Links are all relative, so the output works from file://, GitHub
// Pages, an S3 bucket, or any subpath — DNS can come later.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_DIR, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const DIST = path.join(WEB_DIR, "dist");

// The package users install from, and the install verb the CLI exposes.
const NPM_PKG = "@dragonbot-skills/cli";

// Skills are namespaced on install/download (mirrors the CLI). The
// catalog slug stays bare; the downloaded artifact is prefixed.
const DRAGONBOT_PREFIX = "dragonbot-";
const withPrefix = (v) =>
  v.startsWith(DRAGONBOT_PREFIX) ? v : `${DRAGONBOT_PREFIX}${v}`;

// Rewrite the `name:` field in SKILL.md frontmatter to its prefixed
// form (idempotent) — keeps the CLI and the ZIP download in lockstep.
function prefixFrontmatterName(raw) {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  const header = raw.slice(0, end);
  const rest = raw.slice(end);
  const newHeader = header.replace(
    /^(\s*name\s*:\s*)(.+?)\s*$/m,
    (_m, lead, val) => `${lead}${withPrefix(unquote(val))}`,
  );
  return newHeader + rest;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ─── Skill discovery ───────────────────────────────────────────────

function readSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const file = path.join(SKILLS_DIR, slug, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const { meta, body } = splitFrontmatter(raw);
    skills.push({
      slug,
      name: meta.name || slug,
      description: meta.description || "",
      connections: meta.connections || [],
      body,
    });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

// Minimal frontmatter reader: flat `name:`/`description:` scalars plus
// the nested `requires.connections:` list. Not a full YAML parser —
// just enough for what SKILL.md headers actually carry.
function splitFrontmatter(source) {
  if (!source.startsWith("---")) return { meta: {}, body: source };
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: source };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\s*\n/, "");

  const meta = { connections: [] };
  let inConnections = false;
  for (const rawLine of header.split("\n")) {
    const indented = /^\s+/.test(rawLine);
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Collect list items under `connections:`.
    if (inConnections) {
      if (indented && line.startsWith("- ")) {
        meta.connections.push(line.slice(2).trim());
        continue;
      }
      if (indented) continue; // other nested keys under requires:
      inConnections = false; // dedented — connections block ended
    }

    if (/^connections\s*:/.test(line)) {
      inConnections = true;
      continue;
    }
    if (indented) continue; // skip other nested scalars (e.g. requires:)

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = unquote(line.slice(colon + 1).trim());
    if (key === "name") meta.name = value;
    if (key === "description") meta.description = value;
  }
  return { meta, body };
}

function unquote(v) {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

// ─── Tiny markdown renderer (SKILL.md body → HTML) ─────────────────
// Handles the subset SKILL.md actually uses: headings, blockquotes,
// unordered + task lists, fenced/inline code, bold, links, hr,
// paragraphs. Placeholders use distinctive ASCII tokens that won't
// appear in real skill text, so they can't collide with content.

const CODE_TOKEN = (n) => `@@DBSKILLCODE${n}ENDDB@@`;
const ICODE_TOKEN = (n) => `@@DBSKILLICODE${n}ENDDB@@`;
const CODE_LINE_RE = /^@@DBSKILLCODE(\d+)ENDDB@@$/;
const ICODE_RE = /@@DBSKILLICODE(\d+)ENDDB@@/g;

function renderMarkdown(md) {
  // Pull fenced code blocks out first so their contents aren't mangled.
  const blocks = [];
  md = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return `\n${CODE_TOKEN(blocks.length - 1)}\n`;
  });

  const lines = md.split("\n");
  const out = [];
  let para = [];
  let list = null; // "ul" when inside a list
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push("</ul>");
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    // Restored code-block placeholder on its own line.
    const codeMatch = line.trim().match(CODE_LINE_RE);
    if (codeMatch) {
      flushAll();
      out.push(
        `<pre><code>${escapeHtml(blocks[Number(codeMatch[1])])}</code></pre>`,
      );
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (/^> ?/.test(line)) {
      flushPara();
      flushList();
      quote.push(line.replace(/^> ?/, ""));
      continue;
    }
    flushQuote();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      out.push("<hr />");
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!list) {
        out.push("<ul>");
        list = "ul";
      }
      const task = li[1].match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        const mark = `<span class="task ${checked ? "done" : ""}">${checked ? "☑" : "☐"}</span> `;
        out.push(`<li class="task-item">${mark}${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline(li[1])}</li>`);
      }
      continue;
    }
    flushList();

    para.push(line.trim());
  }
  flushAll();
  return out.join("\n");
}

// Inline formatting: code, bold, links. Pull inline code out first so
// ** inside code isn't treated as bold, then escape, then re-inject.
function inline(text) {
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return ICODE_TOKEN(codes.length - 1);
  });
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) => `<a href="${escapeAttr(href)}">${label}</a>`,
  );
  text = text.replace(
    ICODE_RE,
    (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`,
  );
  return text;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ─── ZIP packaging ─────────────────────────────────────────────────
// Zip the skill folder so the archive's single top-level entry is the
// skill folder itself (`amazon-kw-research/SKILL.md`) — the shape the
// Claude apps' "Upload a skill" flow expects.

function zipSkill(slug) {
  const installSlug = withPrefix(slug);
  // Stage a prefixed copy (folder renamed, SKILL.md name rewritten) so
  // the archive's single root entry is `dragonbot-<slug>/` — exactly
  // what gets uploaded into the Claude apps.
  const stageRoot = path.join(DIST, ".stage");
  const skillStage = path.join(stageRoot, installSlug);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  copyDirRecursive(path.join(SKILLS_DIR, slug), skillStage);
  const md = path.join(skillStage, "SKILL.md");
  if (fs.existsSync(md)) {
    fs.writeFileSync(md, prefixFrontmatterName(fs.readFileSync(md, "utf8")));
  }
  const outPath = path.join(DIST, "zips", `${installSlug}.zip`);
  // -r recurse, -X strip extra file attrs, -q quiet.
  execFileSync("zip", ["-r", "-X", "-q", outPath, installSlug], {
    cwd: stageRoot,
  });
  fs.rmSync(stageRoot, { recursive: true, force: true });
  return installSlug;
}

// ─── HTML scaffolding ──────────────────────────────────────────────

function page({ title, prefix, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${prefix}styles.css" />
</head>
<body>
<header class="site-header">
  <a class="brand" href="${prefix}index.html">🐉 DragonBot <span>Skills</span></a>
  <nav><a href="https://www.npmjs.com/package/${NPM_PKG}">npm</a></nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <p>Install any skill with <code>npx ${NPM_PKG}@latest install &lt;slug&gt;</code> · or download the ZIP and upload it via <em>Customize → Skills → + → Create skill</em> in Claude.</p>
</footer>
<script>
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
  });
});
</script>
</body>
</html>
`;
}

function installBlock(slug) {
  const cmd = `npx ${NPM_PKG}@latest install ${slug}`;
  return `<div class="cmd">
  <code>${escapeHtml(cmd)}</code>
  <button class="copy-btn" data-copy="${escapeAttr(cmd)}" aria-label="Copy install command">Copy</button>
</div>`;
}

function connectionBadges(connections) {
  if (!connections.length) return "";
  const items = connections
    .map((c) => `<span class="badge">${escapeHtml(c)}</span>`)
    .join("");
  return `<div class="connections"><span class="connections-label">Requires</span>${items}</div>`;
}

function renderIndex(skills) {
  const cards = skills
    .map(
      (s) => `<a class="card" href="skills/${encodeURIComponent(s.slug)}.html">
  <h2>${escapeHtml(s.name)}</h2>
  <p class="slug"><code>${escapeHtml(s.slug)}</code></p>
  <p class="desc">${escapeHtml(s.description)}</p>
  ${connectionBadges(s.connections)}
  <span class="more">View skill →</span>
</a>`,
    )
    .join("\n");

  const body = `<section class="hero">
  <h1>DragonBot Skills</h1>
  <p class="lede">Amazon analytics &amp; ops skills for Claude. Install via the CLI, or download a ZIP to upload into the Claude apps.</p>
</section>
<section class="grid">
${cards || '<p class="empty">No skills found.</p>'}
</section>`;
  return page({ title: "DragonBot Skills", prefix: "", body });
}

function renderSkill(s) {
  const body = `<article class="skill">
  <a class="back" href="../index.html">← All skills</a>
  <h1>${escapeHtml(s.name)}</h1>
  <p class="slug"><code>${escapeHtml(s.slug)}</code></p>
  <p class="desc lead">${escapeHtml(s.description)}</p>
  ${connectionBadges(s.connections)}

  <section class="install">
    <h2>Install via CLI</h2>
    ${installBlock(s.slug)}
    <p class="hint">Auto-installs into every Claude Code / Cursor / Codex install it detects, namespaced as <code>${escapeHtml(withPrefix(s.slug))}</code>.</p>
  </section>

  <section class="download">
    <h2>Download as ZIP</h2>
    <a class="dl-btn" href="../zips/${encodeURIComponent(withPrefix(s.slug))}.zip" download>⬇ ${escapeHtml(withPrefix(s.slug))}.zip</a>
    <p class="hint">For the Claude desktop / web apps: <em>Customize → Skills → + → Create skill → Upload a skill</em>.</p>
  </section>

  <section class="readme">
    <h2>What it does</h2>
    <div class="md">${renderMarkdown(s.body)}</div>
  </section>
</article>`;
  return page({ title: `${s.name} — DragonBot Skills`, prefix: "../", body });
}

// ─── Build ─────────────────────────────────────────────────────────

function main() {
  const skills = readSkills();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "skills"), { recursive: true });
  fs.mkdirSync(path.join(DIST, "zips"), { recursive: true });

  fs.writeFileSync(path.join(DIST, "styles.css"), STYLES);
  fs.writeFileSync(path.join(DIST, "index.html"), renderIndex(skills));

  for (const s of skills) {
    fs.writeFileSync(path.join(DIST, "skills", `${s.slug}.html`), renderSkill(s));
    zipSkill(s.slug);
  }

  process.stdout.write(
    `Built ${skills.length} skill page(s) → ${path.relative(ROOT, DIST)}/\n` +
      skills.map((s) => `  • ${s.slug}\n`).join(""),
  );
}

// ─── Styles ────────────────────────────────────────────────────────

const STYLES = `:root{
  --bg:#0c0e14; --panel:#151823; --panel-2:#1c2030; --line:#262b3d;
  --text:#e6e9f0; --muted:#9aa3b8; --accent:#7c5cff; --accent-2:#36d6c3;
  --code-bg:#0a0c12;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
a{color:inherit;text-decoration:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}

.site-header{display:flex;justify-content:space-between;align-items:center;
  padding:18px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;
  background:rgba(12,14,20,.85);backdrop-filter:blur(8px);z-index:10}
.brand{font-weight:700;font-size:1.15rem}
.brand span{color:var(--accent-2)}
.site-header nav a{color:var(--muted);font-size:.9rem}
.site-header nav a:hover{color:var(--text)}

main{max-width:920px;margin:0 auto;padding:40px 24px 64px}

.hero h1{font-size:2.4rem;margin:0 0 .25em;letter-spacing:-.02em}
.hero .lede{color:var(--muted);font-size:1.1rem;max-width:60ch;margin:0 0 8px}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:18px;margin-top:32px}
.card{display:flex;flex-direction:column;gap:8px;padding:22px;border-radius:14px;
  background:var(--panel);border:1px solid var(--line);transition:.15s}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card h2{margin:0;font-size:1.2rem}
.card .desc{color:var(--muted);font-size:.93rem;margin:0;flex:1}
.card .more{color:var(--accent-2);font-size:.88rem;font-weight:600;margin-top:6px}
.slug{margin:0}
.slug code{background:var(--code-bg);padding:2px 8px;border-radius:6px;color:var(--accent-2);border:1px solid var(--line)}

.connections{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0}
.connections-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-right:2px}
.badge{font-size:.74rem;background:var(--panel-2);border:1px solid var(--line);
  color:var(--muted);padding:2px 8px;border-radius:999px}

.skill .back{color:var(--muted);font-size:.9rem;display:inline-block;margin-bottom:18px}
.skill .back:hover{color:var(--text)}
.skill h1{font-size:2rem;margin:0 0 .15em;letter-spacing:-.02em}
.skill .lead{font-size:1.08rem;color:var(--text);max-width:65ch}

.skill section{margin-top:34px}
.skill section h2{font-size:1.05rem;margin:0 0 12px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.06em}

.cmd{display:flex;align-items:stretch;gap:0;background:var(--code-bg);
  border:1px solid var(--line);border-radius:10px;overflow:hidden}
.cmd code{flex:1;padding:14px 16px;color:var(--accent-2);overflow-x:auto;white-space:nowrap}
.copy-btn{border:none;border-left:1px solid var(--line);background:var(--panel-2);
  color:var(--text);padding:0 18px;cursor:pointer;font-weight:600;font-size:.9rem;transition:.15s}
.copy-btn:hover{background:var(--accent);color:#fff}
.copy-btn.copied{background:var(--accent-2);color:#04120f}

.dl-btn{display:inline-block;background:var(--accent);color:#fff;font-weight:600;
  padding:12px 20px;border-radius:10px;transition:.15s}
.dl-btn:hover{filter:brightness(1.1)}
.hint{color:var(--muted);font-size:.86rem;margin:10px 0 0}
.hint em{color:var(--text);font-style:normal}

.md{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:8px 26px 24px}
.md h1,.md h2,.md h3,.md h4{margin:1.3em 0 .5em;line-height:1.3;text-transform:none;
  letter-spacing:0;color:var(--text)}
.md h1{font-size:1.5rem} .md h2{font-size:1.25rem} .md h3{font-size:1.08rem} .md h4{font-size:.98rem}
.md p{margin:.6em 0}
.md ul{margin:.5em 0;padding-left:1.4em}
.md li{margin:.25em 0}
.md code{background:var(--code-bg);padding:1px 6px;border-radius:5px;border:1px solid var(--line)}
.md pre{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;
  padding:14px 16px;overflow-x:auto}
.md pre code{background:none;border:none;padding:0}
.md blockquote{margin:1em 0;padding:2px 18px;border-left:3px solid var(--accent);
  background:var(--panel-2);border-radius:0 8px 8px 0;color:var(--muted)}
.md blockquote p{margin:.5em 0}
.md hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}
.md .task{margin-right:4px}
.md .task.done{color:var(--accent-2)}
.empty{color:var(--muted)}

.site-footer{border-top:1px solid var(--line);padding:24px;text-align:center;
  color:var(--muted);font-size:.86rem}
.site-footer code{background:var(--code-bg);padding:2px 7px;border-radius:6px;border:1px solid var(--line)}
`;

main();
