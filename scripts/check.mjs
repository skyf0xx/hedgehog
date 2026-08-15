#!/usr/bin/env node
// Payload integrity check. Hedgehog's product IS the agents/skills
// payload, so this validates the things that would otherwise ship
// silently broken: frontmatter consistency, cross-references between
// agent/skill files, the Golden Cores' core definitions, the published
// tarball's contents, and the CLI entrypoint.
//
// Run with `pnpm check`. Exits non-zero on any failure — wired into
// publish.yml as a gate before `npm publish`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/hosts/frontmatter.mjs';
import { AGENT_CAPABILITY } from '../src/hosts/capabilities.mjs';
import { loadCore, lintCore } from '../src/db/core.mjs';
import { loadRegistry } from '../src/registry/index.mjs';
import { parseCoreManifest } from '../src/registry/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const failures = [];
const fail = (msg) => failures.push(msg);

async function agentEntries() {
  const dir = join(ROOT, 'src/agents');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const { data } = parse(text);
    out.push({ file, name: data.name, description: data.description, text });
  }
  return out;
}

async function skillEntries() {
  const dir = join(ROOT, 'src/skills');
  const dirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
  const out = [];
  for (const entry of dirs) {
    const path = join(dir, entry.name, 'SKILL.md');
    const text = await readFile(path, 'utf8');
    const { data } = parse(text);
    out.push({ dir: entry.name, name: data.name, description: data.description, text });
  }
  return out;
}

// ── 1. Agent frontmatter ────────────────────────────────────────────────
const agents = await agentEntries();
for (const a of agents) {
  const base = a.file.replace(/\.md$/, '');
  if (a.name !== base) fail(`src/agents/${a.file}: frontmatter name "${a.name}" != filename "${base}"`);
  if (!a.description || !a.description.trim()) fail(`src/agents/${a.file}: missing or empty description`);
}

// ── 2. Skill frontmatter ────────────────────────────────────────────────
const skills = await skillEntries();
for (const s of skills) {
  if (s.name !== s.dir) fail(`src/skills/${s.dir}/SKILL.md: frontmatter name "${s.name}" != dirname "${s.dir}"`);
  if (!s.description || !s.description.trim()) fail(`src/skills/${s.dir}/SKILL.md: missing or empty description`);
}

const agentNames = new Set(agents.map((a) => a.name));
const cores = await loadRegistry();
const skillNames = new Set(skills.map((s) => s.name));
const coreNames = new Set(cores.map((c) => c.name));

// The agents and skills each core ships. An engine file naming one of
// these is referring to something a project gets from its core package
// rather than from here, which resolves — so they count alongside the
// engine's own names. Read from the manifests vendored under
// repro/fixtures/cores/, so this check needs no package fetched.
const coreOwned = new Set();
const coreAgents = new Set();
for (const core of cores) {
  const manifest = parseCoreManifest(
    await readFile(join(ROOT, `repro/fixtures/cores/${core.name}.manifest.yaml`), 'utf8'),
    `${core.name}.manifest.yaml`,
  );
  for (const name of [...manifest.agents, ...manifest.skills]) coreOwned.add(name);
  for (const name of manifest.agents) coreAgents.add(name);
}

// ── 3. Cross-references: every agent named in AGENT_CAPABILITY exists,
//    and every agent file exists in AGENT_CAPABILITY (capabilities.mjs
//    fails closed to 'readonly' for unknown agents, so a silently
//    unlisted agent is a real gap, not a style nit). The table covers
//    the cores' agents too — they install into a project alongside the
//    engine's own, and a host that cannot register a per-agent grant
//    reads their capability from here. ─────────────────────────────────
const installable = new Set([...agentNames, ...coreAgents]);
for (const capName of Object.keys(AGENT_CAPABILITY)) {
  if (!installable.has(capName)) {
    fail(`src/hosts/capabilities.mjs: AGENT_CAPABILITY references unknown agent "${capName}"`);
  }
}
for (const name of installable) {
  if (!(name in AGENT_CAPABILITY)) {
    fail(`src/hosts/capabilities.mjs: AGENT_CAPABILITY has no entry for agent "${name}" (would fail closed to readonly)`);
  }
}

// ── 4. Cross-references: every backtick-quoted `agent-name` or
//    `skill-name` mentioned in agent/skill bodies resolves to a real
//    file, catching typos and stale renames. ───────────────────────────
const allEntries = [
  ...agents.map((a) => ({ label: `src/agents/${a.file}`, text: a.text })),
  ...skills.map((s) => ({ label: `src/skills/${s.dir}/SKILL.md`, text: s.text })),
];
const MENTION = /`(hedgehog-[a-z-]+|landing-[a-z-]+|nx-[a-z-]+|backend-eng|front-end-eng|layer-eng|planner|bootstrap|reviewer|tweaker|ux-planner|link-workspace-packages|conventional-commits)`/g;
for (const { label, text } of allEntries) {
  for (const m of text.matchAll(MENTION)) {
    const ref = m[1];
    if (!agentNames.has(ref) && !skillNames.has(ref) && !coreNames.has(ref) && !coreOwned.has(ref)) {
      fail(`${label}: references \`${ref}\`, which is not an agent, skill, or core name`);
    }
  }
}

// ── 5. Both shipped core.yaml files load, validate, and lint cleanly.
//    The lint (core.mjs's lintCore) is heuristic and only warns in a
//    project, but a shipped core is the worked example every authored
//    core is written against, so a warning on one is a release blocker
//    here — and a shipped core tripping it is also the evidence that the
//    heuristic cries wolf. ────────────────────────────────────────────
for (const core of ['full-stack-app', 'landing-page']) {
  const path = join(ROOT, `repro/fixtures/cores/${core}.core.yaml`);
  try {
    const loaded = await loadCore(path);
    if (loaded.id !== core) fail(`${path}: id "${loaded.id}" != core name "${core}"`);
    for (const warning of lintCore(loaded)) fail(`${path}: ${warning}`);
  } catch (err) {
    fail(`${path}: failed to load — ${err.message}`);
  }
}

// ── 5b. graph.html's JS/CSS deps are vendored locally, not fetched from
//    a CDN — `hedgehog graph` must work with no internet connection.
//    Only checks <script src> and <link href> — the asset-loading
//    surface — so an ordinary external link (e.g. a GitHub URL in page
//    copy) doesn't false-positive. ──────────────────────────────────────
{
  const graphHtmlPath = join(ROOT, 'src/templates/graph.html');
  const graphHtml = await readFile(graphHtmlPath, 'utf8');
  const ASSET_TAG = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["'](https?:\/\/[^"']+)["']/g;
  for (const m of graphHtml.matchAll(ASSET_TAG)) {
    fail(`${graphHtmlPath}: loads an asset from "${m[1]}" — vendor it under src/templates/vendor/ instead`);
  }
  const vendorDir = join(ROOT, 'src/templates/vendor');
  const requiredVendorFiles = [
    'react.production.min.js',
    'react-dom.production.min.js',
    'reactflow.umd.js',
    'reactflow.css',
    'dagre.min.js',
  ];
  for (const name of requiredVendorFiles) {
    try {
      const { size } = await stat(join(vendorDir, name));
      if (size < 1000) fail(`src/templates/vendor/${name}: suspiciously small (${size} bytes) — likely a failed download`);
    } catch {
      fail(`src/templates/vendor/${name}: missing`);
    }
  }
}

// ── 6. Published tarball contains every agent, every skill, and the
//    db/hosts/registry modules the CLI needs at runtime. ───────────────
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  // npm <12 prints a JSON array; npm >=12 prints an object keyed by package name.
  const { files: packed } = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const packedSet = new Set(packed.map((f) => f.path));
  const required = [
    'bin/cli.mjs',
    'src/db/init.mjs',
    'src/db/core.mjs',
    'src/hosts/index.mjs',
    'src/hosts/routing.mjs',
    'src/hosts/capabilities.mjs',
    'src/hosts/frontmatter.mjs',
    'src/registry/cores.json',
    'src/registry/index.mjs',
    'src/registry/fetch.mjs',
    'src/registry/manifest.mjs',
    'src/templates/CLAUDE.md',
    'src/templates/graph.html',
    ...agents.map((a) => `src/agents/${a.file}`),
    ...skills.map((s) => `src/skills/${s.dir}/SKILL.md`),
  ];
  for (const path of required) {
    if (!packedSet.has(path)) fail(`npm pack: missing "${path}" from published tarball`);
  }
} catch (err) {
  fail(`npm pack --dry-run failed: ${err.message}`);
}

// ── 7. CLI entrypoint runs. ─────────────────────────────────────────────
try {
  execFileSync('node', ['bin/cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
} catch (err) {
  fail(`bin/cli.mjs --help exited non-zero: ${err.message}`);
}

// ── Report ───────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log(
  `ok — ${agents.length} agents, ${skills.length} skills, ${cores.length} cores, tarball, CLI`,
);
