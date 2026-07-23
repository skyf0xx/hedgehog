#!/usr/bin/env node
// Hedgehog installer. Copies the agents/skills payload and root templates
// into the current repo, so the discipline travels with the project.
//
// Usage:
//   npx @skyf0xx/hedgehog init          scaffold into the current directory
//   npx @skyf0xx/hedgehog init --force  overwrite files that already exist
//   npx @skyf0xx/hedgehog update        refresh .claude/agents + .claude/skills
//   npx @skyf0xx/hedgehog --help

import { cp, mkdir, access, readdir, stat, rm } from 'node:fs/promises';
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

// npm strips files literally named `.gitignore` from published tarballs,
// even when the containing directory is listed in `files`. Stored under
// this name in the package, renamed back on copy.
const DOTFILE_RENAMES = { 'gitignore.template': '.gitignore' };

// ── the payload: what gets copied, and to where under the target repo ───
// `dir` entries copy a whole tree; `file` entries copy a single file and
// may rename (templates lose their src/templates/ prefix at the root).
const PLAN = [
  { type: 'dir', from: 'src/agents', to: '.claude/agents' },
  { type: 'dir', from: 'src/skills', to: '.claude/skills' },
  // The vendored BMAD-METHOD planning shelf that hedgehog-planning-intake
  // runs — referenced by repo-root-relative path (skills/BMAD/...), so it
  // lands there rather than under .claude/.
  { type: 'dir', from: 'skills/BMAD', to: 'skills/BMAD' },
  { type: 'file', from: 'src/templates/CLAUDE.md', to: 'CLAUDE.md' },
  { type: 'file', from: 'src/templates/TODO.md', to: 'TODO.md' },
  // The pre-built, pre-verified core Nx workspace — packages/config,
  // packages/db, apps/api, apps/web, and every enforcement file
  // (lefthook, commitlint, phase gate, module boundaries). Lands the
  // root package.json too, so there's no separate placeholder for it.
  // `hedgehog-bootstrap-core` verifies this on first run rather than
  // generating it live — see that skill for what's in here and why.
  { type: 'dir', from: 'src/golden-core', to: '.' },
];

// The subset of PLAN that's the discipline's payload rather than
// project-specific or write-once content: `update` re-copies exactly
// this, always overwriting, since a consuming project's own
// .claude/agents and .claude/skills are supposed to match upstream
// verbatim. CLAUDE.md/TODO.md carry project-filled content, golden-core
// is verified once by hedgehog-bootstrap-core, and skills/BMAD is
// re-vendored only deliberately (bmad-revendor) — none of those belong
// in an update.
const UPDATE_PLAN = [
  { type: 'dir', from: 'src/agents', to: '.claude/agents' },
  { type: 'dir', from: 'src/skills', to: '.claude/skills' },
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
      const renamed = DOTFILE_RENAMES[rel] ?? rel;
      out.push({ src: abs, dest: join(DEST_ROOT, entry.to, renamed) });
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
  npx @skyf0xx/hedgehog update          refresh .claude/agents + .claude/skills
  npx @skyf0xx/hedgehog --help

After it runs, commit the .claude/ payload, open Claude Code, and say
"bootstrap this project" to trigger the hedgehog-bootstrap skill.

${bold('update')} re-copies only .claude/agents and .claude/skills from the
installed Hedgehog version, so an already-bootstrapped project can pick up
agent/skill changes from a newer release. It always overwrites those two
directories and never touches CLAUDE.md, TODO.md, golden-core, or
skills/BMAD — those are project-specific or updated deliberately, not by
this command.
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
  console.log(`  1. ${bold('git add -A && git commit -m "chore: install Hedgehog"')}`);
  console.log(`  2. ${bold('pnpm install')}`);
  console.log(`  3. Open Claude Code and say: ${bold('"bootstrap this project"')}\n`);
  console.log(
    dim(
      'The core workspace (Nx, packages/config, packages/db, apps/api,\n' +
        'apps/web) is already scaffolded and verified — bootstrap now only\n' +
        'runs whichever add-ons (Auth, Queue, Mobile) Intake calls for.',
    ),
  );
}

async function update() {
  // Full replace, not a merge: clear each destination dir first so a
  // rename or removal upstream (e.g. an agent renamed between releases)
  // doesn't leave a stale file sitting alongside the new one.
  for (const entry of UPDATE_PLAN) {
    await rm(join(DEST_ROOT, entry.to), { recursive: true, force: true });
  }

  let written = 0;
  for (const entry of UPDATE_PLAN) {
    const files = await plannedFiles(entry);
    for (const f of files) {
      await mkdir(dirname(f.dest), { recursive: true });
      await cp(f.src, f.dest);
      written++;
      console.log(`  ${green('update')}  ${relative(DEST_ROOT, f.dest)}`);
    }
  }

  console.log(
    `\n${green(bold('Hedgehog agents/skills updated.'))} ${dim(`${written} files written`)}\n`,
  );
  console.log('Next steps:');
  console.log(`  1. ${bold('git diff .claude/')} to review what changed`);
  console.log(`  2. ${bold('git add -A && git commit -m "chore: update hedgehog"')}\n`);
  console.log(
    dim(
      'CLAUDE.md, TODO.md, the golden-core workspace, and skills/BMAD are\n' +
        'untouched — those carry project-specific or write-once content.',
    ),
  );
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

  if (cmd === 'update') {
    await update();
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
