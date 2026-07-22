#!/usr/bin/env node
// Hedgehog installer. Copies the agents/skills payload and root templates
// into the current repo, so the discipline travels with the project.
//
// Usage:
//   npx @skyf0xx/hedgehog init          scaffold into the current directory
//   npx @skyf0xx/hedgehog init --force  overwrite files that already exist
//   npx @skyf0xx/hedgehog --help

import { cp, mkdir, access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const DEST_ROOT = process.cwd();

// ── tiny ANSI helpers (no deps) ─────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const dim = (s) => paint('2', s);

// ── the payload: what gets copied, and to where under the target repo ───
// `dir` entries copy a whole tree; `file` entries copy a single file and
// may rename (templates lose their src/templates/ prefix at the root).
const PLAN = [
  { type: 'dir', from: 'src/agents', to: '.claude/agents' },
  { type: 'dir', from: 'src/skills', to: '.claude/skills' },
  { type: 'file', from: 'src/templates/CLAUDE.md', to: 'CLAUDE.md' },
  { type: 'file', from: 'src/templates/TODO.md', to: 'TODO.md' },
  // A minimal root package.json so bootstrap's `nx init` scaffolds a real
  // pnpm workspace rather than falling into standalone (.nx wrapper) mode.
  { type: 'file', from: 'src/templates/package.json', to: 'package.json' },
];

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

// Every destination file this plan would write, resolved absolute.
async function plannedFiles(entry) {
  const src = join(PKG_ROOT, entry.from);
  if (entry.type === 'file') {
    return [{ src, dest: join(DEST_ROOT, entry.to) }];
  }
  const out = [];
  async function walk(rel) {
    const abs = join(src, rel);
    const st = await stat(abs);
    if (st.isDirectory()) {
      for (const name of await readdir(abs)) await walk(join(rel, name));
    } else {
      out.push({ src: abs, dest: join(DEST_ROOT, entry.to, rel) });
    }
  }
  await walk('.');
  return out;
}

function help() {
  console.log(`
${bold('Hedgehog installer')}

Copies the Hedgehog agents and skills into ${bold('.claude/')} and drops the
CLAUDE.md / TODO.md templates into the repo root, so the discipline is
committed alongside your code.

${bold('Usage')}
  npx @skyf0xx/hedgehog init            scaffold into the current directory
  npx @skyf0xx/hedgehog init --force    overwrite existing files
  npx @skyf0xx/hedgehog --help

After it runs, commit the .claude/ payload, open Claude Code, and say
"bootstrap this project" to trigger the hedgehog-bootstrap skill.
`);
}

async function init({ force }) {
  // Resolve the full list of writes up front so we can detect conflicts
  // before touching anything.
  const groups = [];
  for (const entry of PLAN) {
    const files = await plannedFiles(entry);
    groups.push({ entry, files });
  }

  const conflicts = [];
  for (const { files } of groups) {
    for (const f of files) {
      if (await exists(f.dest)) conflicts.push(f.dest);
    }
  }

  if (conflicts.length && !force) {
    console.error(`\n${red(bold('Refusing to overwrite existing files.'))}\n`);
    for (const c of conflicts) {
      console.error(`  ${yellow('exists')}  ${relative(DEST_ROOT, c) || c}`);
    }
    console.error(
      `\nRe-run with ${bold('--force')} to overwrite, or move these aside first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let written = 0;
  let overwritten = 0;
  for (const { files } of groups) {
    for (const f of files) {
      const already = await exists(f.dest);
      await mkdir(dirname(f.dest), { recursive: true });
      await cp(f.src, f.dest);
      if (already) overwritten++;
      else written++;
      const label = already ? yellow('overwrite') : green('create');
      console.log(`  ${label}  ${relative(DEST_ROOT, f.dest)}`);
    }
  }

  console.log(
    `\n${green(bold('Hedgehog installed.'))} ${dim(
      `${written} created${overwritten ? `, ${overwritten} overwritten` : ''}`,
    )}\n`,
  );
  console.log('Next steps:');
  console.log(`  1. ${bold('git add .claude CLAUDE.md TODO.md package.json && git commit')}`);
  console.log(`  2. Open Claude Code and say: ${bold('"bootstrap this project"')}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    help();
    return;
  }
  const cmd = args[0];
  const force = args.includes('--force') || args.includes('-f');

  if (cmd === 'init') {
    await init({ force });
    return;
  }

  console.error(`${red('Unknown command:')} ${cmd}\n`);
  help();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n${red(bold('Install failed:'))} ${err.message}\n`);
  process.exitCode = 1;
});
