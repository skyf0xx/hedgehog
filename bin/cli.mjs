#!/usr/bin/env node
// Hedgehog installer. Copies the agents/skills payload and root templates
// into the current repo, so the discipline travels with the project.
//
// Usage:
//   npx @skyf0xx/hedgehog init                        install; planner picks the core at intake
//   npx @skyf0xx/hedgehog init --ts-full-stack-app     scaffold the full-stack-app core now
//   npx @skyf0xx/hedgehog init --landing-page          scaffold the landing-page core now
//   npx @skyf0xx/hedgehog init --cursor                install for Cursor (default: Claude Code)
//   npx @skyf0xx/hedgehog init --all-hosts             install for every supported coding agent
//   npx @skyf0xx/hedgehog init --force                 overwrite files that already exist
//   npx @skyf0xx/hedgehog update                       refresh the installed agents + skills
//   npx @skyf0xx/hedgehog --help

import { cp, mkdir, access, readdir, stat, rm, readFile, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { dbInit, DB_PATH, dbAbsPath, openDb } from '../src/db/init.mjs';
import { loadCore, lintCore, isModuleAxis } from '../src/db/core.mjs';
import { planTasks, CORE_INTENT_ID } from '../src/db/plan.mjs';
import { addIntent, INTENTS_DIR } from '../src/db/intent.mjs';
import {
  nextTask,
  formatNext,
  formatPacket,
  stalledTasks,
  taskPacket,
  taskStatusLine,
} from '../src/db/next.mjs';
import { verifyTask } from '../src/db/verify.mjs';
import {
  claimTasks,
  claimTask,
  releaseTask,
  renewLease,
  retryTask,
} from '../src/db/claim.mjs';
import { readyTasks, formatReady } from '../src/db/ready.mjs';
import { graphStatus, formatStatus } from '../src/db/status.mjs';
import { boundaryState, formatBoundary, formatPosition, formatHandoff } from '../src/db/boundary.mjs';
import { commitGateStatus, formatCommitGate } from '../src/db/gate.mjs';
import { detectDrift, recompileTasks, formatRecompile } from '../src/db/drift.mjs';
import { coreMissingRequirements, missingBinaries } from '../src/db/requires.mjs';
import { whyPath, formatWhy } from '../src/db/why.mjs';
import { addFriction, listFriction } from '../src/db/friction.mjs';
import { addDebt, listDebt } from '../src/db/debt.mjs';
import { rebuildDb } from '../src/db/rebuild.mjs';
import { loadOverrides, addOverride, orphanedOverrides, OVERRIDES_DIR } from '../src/db/overrides.mjs';
import { HOSTS, HOST_FLAGS, DEFAULT_HOST, availableHosts } from '../src/hosts/index.mjs';
import { recordHosts, installedHosts } from '../src/hosts/installed.mjs';
import { recordVersion, checkForUpdate, installedVersion } from '../src/hosts/version.mjs';
import { loadRegistry, resolveCore } from '../src/registry/index.mjs';
import { fetchCore, cachedCore, cachedVersions } from '../src/registry/fetch.mjs';
import { recordCore, installedCore } from '../src/registry/installed.mjs';

const AUTHORED_CORE_PATH = '.hedgehog/core.yaml';

const BLOCKED_REASON_LABELS = {
  verification_failed: 'verification failed',
  scope_violation: 'scope violation',
  lease_expired: 'lease expired',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const DEST_ROOT = process.cwd();
const DEFAULT_CORE = 'full-stack-app';

// The version of the payload this CLI carries — what `init` and
// `update` stamp into the project they write to.
const PKG_VERSION = JSON.parse(
  await readFile(join(PKG_ROOT, 'package.json'), 'utf8'),
).version;

// One install flag per core that has one, named for what a user is asking
// to build rather than for the package that ships it — the two diverge
// deliberately so the CLI's public surface stays stable while cores are
// renamed or added underneath it. Derived from src/registry/cores.json,
// which owns the core → package → flag table: adding a core means adding
// one entry there and nothing here. A core with no flag (`authored`) is
// absent from this map on purpose; it is chosen during planning, never
// off a fixed list at install time.
async function coreFlags() {
  return Object.fromEntries(
    (await loadRegistry()).filter((c) => c.flag).map((c) => [c.flag, c.name]),
  );
}

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

// Build artifacts that must never be copied into a consuming project,
// even if a future publish accidentally includes them: the full-stack-app
// golden core documents that `node_modules` is regenerated by `pnpm
// install` in step 4, not shipped, and a platform-specific `node_modules`
// snapshot from the publisher's machine can be stale or broken for
// everyone else (e.g. a dangling optional-dependency symlink).
const SKIP_DIR_NAMES = new Set(['node_modules', '.nx', 'dist', '.next', 'out-tsc']);

// Every core the registry lists is a valid --core value.
async function availableCores() {
  return (await loadRegistry()).map((c) => c.name).sort();
}

// The core named on the command line, or null when none was — which is
// the deferred install, where planner picks the core at planning intake.
// `--core <name>`, `--core=<name>` and a core's own shorthand flag all
// name one; the value is returned as written and resolved by the caller,
// so an unknown name reports itself rather than being read as "none".
async function namedCore(args) {
  const flags = await coreFlags();
  const shorthand = args.find((a) => a in flags);
  if (shorthand) return flags[shorthand];

  const eq = args.find((a) => a.startsWith('--core='));
  if (eq) return eq.slice('--core='.length);

  const at = args.indexOf('--core');
  if (at !== -1) return args[at + 1] ?? '';

  return null;
}

// ── the payload: what gets copied, and to where under the target repo ───
// `dir` entries copy a whole tree; `file` entries copy a single file and
// may rename (templates lose their src/templates/ prefix at the root);
// `merge` entries concatenate a shared shell with a core-specific include
// at {{CORE_SECTION}} (see CLAUDE.md template plumbing below).
// A core's own agents and skills install only for the core the project
// chose; `planner` runs core selection from `hedgehog cores list`, which
// reads the registry rather than whatever is installed on disk.
//
// `core` is `null` on a deferred install (plain `init`, no explicit
// flag): the payload is the shared agents/skills/build-graph only, with
// which core applies left for `planner` to decide. `bootstrap` lands the
// core workspace and fills the CLAUDE.md section for whichever core
// `planner` picks — the first time either way. An explicit flag
// (`--ts-full-stack-app`, `--landing-page`) is a confirmed choice, so it
// scaffolds that workspace immediately, at install time.
//
// A core is passed in as `{ manifest, root }` from fetchCore — the parsed
// hedgehog-core.yaml and the directory that package extracted to. Its
// entries carry `root`, so they resolve against the package rather than
// against this one; every other entry is engine payload and resolves
// against PKG_ROOT.
//
// `hostOnly` plans just the parts that differ per host — used when a
// second host is added to a project whose shared payload (the vendored
// shelves, the core workspace) is already on disk.
function plan(core, host = DEFAULT_HOST, { hostOnly = false } = {}) {
  const h = HOSTS[host];
  const perHost = [
    { type: 'dir', from: 'src/agents', to: h.agentsDir, emit: h.emitAgent },
    { type: 'dir', from: 'src/skills', to: h.skillsDir },
    // Whatever else this host needs to find the payload — its own rules
    // file, extension manifest, or routing doc. Empty for a host that
    // auto-loads its bootstrap file and registers agents from disk.
    ...(h.extraEntries ?? []),
  ];

  // Host-independent: one copy per project however many hosts read it.
  const shared = hostOnly
    ? []
    : [
        // The vendored BMAD-METHOD planning shelf that
        // hedgehog-planning-intake runs — referenced by repo-root-relative
        // path (vendor-skills/BMAD/...), so it lands there rather than under
        // a host's own directory.
        { type: 'dir', from: 'vendor-skills/BMAD', to: 'vendor-skills/BMAD' },
      ];

  const base = [...perHost, ...shared];

  if (core === null) {
    return [
      ...base,
      // The shell with its {{CORE_SECTION}} placeholder left unfilled —
      // whichever bootstrap-core skill runs first fills it in for the
      // core planner actually picked. {{HOST_DISPATCH}} is filled now:
      // which host this is doesn't depend on the core.
      {
        type: 'merge',
        shell: 'src/templates/CLAUDE.md',
        dispatch: `src/hosts/${host}/DISPATCH.md`,
        to: h.bootstrapFile,
      },
    ];
  }

  return [
    ...base,
    ...corePayload(core, h, { hostOnly }),
    {
      type: 'merge',
      shell: 'src/templates/CLAUDE.md',
      // The core's own CLAUDE.md section, read from the package it ships
      // in rather than from the engine.
      include: core.manifest.template,
      includeRoot: core.root,
      dispatch: `src/hosts/${host}/DISPATCH.md`,
      to: h.bootstrapFile,
    },
  ];
}

// What a core package contributes to a project: the agents and skills it
// names, the shelves it vendors, and — for a core that scaffolds one —
// its pre-built workspace at repo root.
//
// The manifest names each agent and skill individually rather than
// shipping a directory to copy wholesale, so only the pieces this core
// declares land: a project on one core never picks up another's toolset.
function corePayload(core, h, { hostOnly = false } = {}) {
  const { manifest, root } = core;

  const perHost = [
    ...manifest.agents.map((name) => ({
      type: 'file',
      root,
      from: `agents/${name}.md`,
      to: `${h.agentsDir}/${name}.md`,
      emit: h.emitAgent,
    })),
    ...manifest.skills.map((name) => ({
      type: 'dir',
      root,
      from: `skills/${name}`,
      to: `${h.skillsDir}/${name}`,
    })),
  ];

  if (hostOnly) return perHost;

  return [
    ...perHost,
    // Vendored shelves this core's agents load, referenced by
    // repo-root-relative path the same way the engine's own are.
    ...manifest.vendor_skills.map((name) => ({
      type: 'dir',
      root,
      from: `vendor-skills/${name}`,
      to: `vendor-skills/${name}`,
    })),
    // The pre-built, pre-verified workspace for this core — everything a
    // fresh project of that shape needs at repo root (lands the root
    // package.json too, so there's no separate placeholder for it). The
    // relevant bootstrap-core skill verifies this on first run rather
    // than generating it live. A core that scaffolds nothing (its
    // workspace is designed during planning) declares no `workspace`.
    ...(manifest.workspace ? [{ type: 'dir', root, from: manifest.workspace, to: '.' }] : []),
  ];
}

// The subset of plan() that's the discipline's payload rather than
// project-specific or write-once content: `update` re-copies exactly
// this, always overwriting, since a consuming project's installed agents
// and skills are supposed to match upstream verbatim. That payload is
// the engine's shared agents and skills plus the installed core's own —
// both are upstream content a project is meant to hold verbatim, and a
// core release ships fixes to its agents and skills the same way the
// engine does.
//
// The bootstrap file carries project-filled content, the build graph and
// core workspace are verified once by their own init/bootstrap-core
// steps, and vendored shelves are re-vendored only deliberately (a manual
// re-vendor, per each shelf's ATTRIBUTION.md) — none of those belong in
// an update, so a core's `workspace` and `vendor_skills` are left alone
// here while its agents and skills are refreshed.
function updatePlan(host = DEFAULT_HOST, core = null) {
  const h = HOSTS[host];
  return [
    { type: 'dir', from: 'src/agents', to: h.agentsDir, emit: h.emitAgent },
    { type: 'dir', from: 'src/skills', to: h.skillsDir },
    ...(core ? corePayload(core, h, { hostOnly: true }) : []),
    // Derived from the agents and skills above — an agent added, renamed,
    // or redescribed upstream has to be reflected in the index that
    // points at it, so it is regenerated alongside them.
    ...(h.extraEntries ?? []).filter((e) => e.type === 'generated'),
  ];
}

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

// Printed by every command that writes to the build graph, before it
// writes. DB_PATH is relative (`.hedgehog/hedgehog.db`), so which
// database a command actually opens depends entirely on the directory it
// was run from — a recovery command run one directory up silently opens
// (or creates) a different database, matches nothing, and reports
// success. Naming the absolute path on every write makes that visible in
// the output instead of only in the outcome.
function printDbTarget() {
  console.log(`  ${dim('db')}      ${dbAbsPath()}`);
}

// Runs once at the top of every command that needs the build graph. A
// fresh clone has no `.hedgehog/hedgehog.db` (it's a derived artifact,
// not committed) but does have `.hedgehog/intents/*.json` — the committed
// source of truth — so this reconstructs the DB automatically instead of
// making every such command fail with "no build graph" on a repo that
// only just lost the file it never should have needed committed. If
// there's nothing to rebuild from either (a genuinely fresh project, no
// intents yet), this no-ops and leaves the DB missing — the caller's own
// existing "No build graph found" guard still fires for that case.
// `log` exists for the one caller whose stdout is a machine-consumable
// payload (`hedgehog boundary`): the rebuild notice is commentary, and
// commentary on stdout would corrupt a block meant to be captured or
// piped. Every other command leaves it at the default.
async function ensureDb({ log = console.log } = {}) {
  if (await exists(DB_PATH)) return;

  let intentFiles = [];
  try {
    intentFiles = (await readdir(INTENTS_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    // .hedgehog/intents/ doesn't exist yet — nothing to rebuild from.
  }
  if (intentFiles.length === 0) return;

  const corePath = await resolveCorePath();
  if (!corePath) return;

  await dbInit(DB_PATH);
  const db = openDb();
  let result;
  try {
    result = await rebuildDb(db, { corePath });
  } finally {
    db.close();
  }
  log(
    `${dim('DB missing — rebuilt from')} ${bold(INTENTS_DIR)}${dim(':')} ${dim(`${result.intentsReplayed} intent(s) replayed, ${result.tasksMarkedComplete} task(s) marked complete`)}\n`,
  );
  warnRebuildDrift(result, corePath);
}

// A rebuild re-derives every task from the current core.yaml and the
// committed intents. Nothing else is committed — a task row someone
// patched by hand has no source to replay from — so say plainly what a
// rebuild can and cannot carry, and surface any task that ends up
// disagreeing with core.yaml.
function warnRebuildDrift({ drift }, corePath) {
  if (!drift || drift.length === 0) return;
  console.log(
    `${yellow(bold('Core drift after rebuild.'))} ${drift.length} task(s) do not match ${bold(corePath)}.\n` +
      `A rebuild replays ${bold(INTENTS_DIR)} and re-derives tasks from core.yaml; task rows\n` +
      'edited by hand have no committed source and are not replayed. Run\n' +
      `${bold('hedgehog status')} for the divergence, ${bold('hedgehog plan --recompile')} to reconcile.\n`,
  );
}

// Debt and friction notes are operator-recorded and have no committed
// source, so a rebuild carries them across by task id. A note whose task
// is no longer in the recompiled graph — its intent file was renamed,
// deleted, or its layer sequence changed — has nowhere to re-attach.
// Friction notes survive unattached (their task_id is nullable); debt
// notes are lost, so both are printed with their text rather than
// disappearing into a count.
function warnOrphanedNotes({ orphanedNotes }) {
  if (!orphanedNotes || orphanedNotes.length === 0) return;
  console.log(
    `${yellow(bold('Notes without a task after rebuild.'))} ${orphanedNotes.length} note(s) referenced a\n` +
      'task the recompiled graph no longer holds. Friction notes were kept unattached;\n' +
      'debt notes could not be, so they are reproduced here:\n',
  );
  for (const note of orphanedNotes) {
    console.log(`  ${dim(note.kind)}  ${bold(note.taskId)}  ${note.note}`);
  }
  console.log('');
}

// Writes one planned file to disk — a straight copy, or for a `merge`
// entry, the shell template with {{CORE_SECTION}} replaced by the
// chosen core's include.
async function writePlannedFile(f) {
  await mkdir(dirname(f.dest), { recursive: true });
  if (f.merge) {
    let out = await readFile(join(PKG_ROOT, f.merge.shell), 'utf8');
    // A deferred install has no core yet, so {{CORE_SECTION}} stays put
    // for whichever bootstrap-core skill runs first to fill in. The host
    // is always known at install time, so {{HOST_DISPATCH}} never is.
    if (f.merge.include) {
      const section = await readFile(
        join(f.merge.includeRoot ?? PKG_ROOT, f.merge.include),
        'utf8',
      );
      out = out.replaceAll('{{CORE_SECTION}}', section.trimEnd());
    }
    const dispatch = await readFile(join(PKG_ROOT, f.merge.dispatch), 'utf8');
    await writeFile(f.dest, out.replaceAll('{{HOST_DISPATCH}}', dispatch.trimEnd()));
    return;
  }
  // Rendered from the payload rather than copied from it — the routing
  // doc's tables are built from the agents' and skills' own frontmatter.
  if (f.generate) {
    await writeFile(f.dest, await f.generate({ pkgRoot: PKG_ROOT, projectRoot: DEST_ROOT }));
    return;
  }
  // A host whose format differs from the canonical one rewrites the file
  // on the way in. Hosts that read the canonical format have no emitter,
  // so their payload is copied verbatim.
  if (f.emit) {
    await writeFile(f.dest, f.emit(await readFile(f.src, 'utf8'), { src: f.src }));
    return;
  }
  await cp(f.src, f.dest);
}

// Every destination file this plan would write, resolved absolute.
async function plannedFiles(entry) {
  if (entry.type === 'merge') {
    return [{ dest: join(DEST_ROOT, entry.to), merge: entry }];
  }
  if (entry.type === 'generated') {
    return [{ dest: join(DEST_ROOT, entry.to), generate: entry.generate }];
  }
  // `root` names the package an entry's sources come from — a fetched
  // core's extraction directory. Engine payload carries none and resolves
  // against this package.
  const src = join(entry.root ?? PKG_ROOT, entry.from);
  if (entry.type === 'file') {
    return [{ src, dest: join(DEST_ROOT, entry.to), emit: entry.emit }];
  }
  const out = [];
  async function walk(rel) {
    const abs = join(src, rel);
    const st = await stat(abs);
    if (st.isDirectory()) {
      for (const name of await readdir(abs)) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        await walk(join(rel, name));
      }
    } else {
      const renamed = DOTFILE_RENAMES[rel] ?? rel;
      out.push({ src: abs, dest: join(DEST_ROOT, entry.to, renamed), emit: entry.emit });
    }
  }
  await walk('.');
  return out;
}

async function help() {
  const cores = await availableCores();
  console.log(`
${bold('Hedgehog installer')}

Copies the Hedgehog agents and skills into your coding agent's own
directory, drops that agent's instructions file, an AGENTS.md index, and an
empty build graph (${bold('.hedgehog/hedgehog.db')}) into the repo root, so
the discipline is committed alongside your code.

${bold('Usage')}
  npx @skyf0xx/hedgehog init                      install; planner picks the core at intake
  npx @skyf0xx/hedgehog init --core <name>        install that core now, by name
  npx @skyf0xx/hedgehog init --ts-full-stack-app  scaffold the full-stack-app core now
  npx @skyf0xx/hedgehog init --landing-page       scaffold the landing-page core now
  npx @skyf0xx/hedgehog cores list                every core this release can install
  npx @skyf0xx/hedgehog init --cursor             install for Cursor (default: Claude Code)
  npx @skyf0xx/hedgehog init --host=claude,gemini install for several coding agents at once
  npx @skyf0xx/hedgehog init --all-hosts          install for every supported coding agent
  npx @skyf0xx/hedgehog init --force              overwrite existing files
  npx @skyf0xx/hedgehog update                    refresh the installed agents + skills
  npx @skyf0xx/hedgehog update --check            report whether a newer release is published
  npx @skyf0xx/hedgehog db init                   create .hedgehog/hedgehog.db if absent
  npx @skyf0xx/hedgehog db rebuild                re-derive the build graph from committed intents + git history
  npx @skyf0xx/hedgehog plan                      compile pending intents into tasks + dependencies
                                                   (starts no graph server; --no-open says so explicitly)
  npx @skyf0xx/hedgehog plan --open               also start the graph server and open it, if anything compiled
  npx @skyf0xx/hedgehog plan --recompile          rewrite core.yaml-derived fields on not-started tasks
                                                   [--dry-run] [--include-blocked] [--strict]
  npx @skyf0xx/hedgehog override add <task-id> --scope <glob> [--scope <glob>...] --reason "<why>"
                                                   record a committed, additive-only scope exception for one task
  npx @skyf0xx/hedgehog override list             list recorded scope overrides
  npx @skyf0xx/hedgehog intent add [flags]        add an intent (rules/requirements/dependencies)
  npx @skyf0xx/hedgehog intent add --file <path>  add an intent from a JSON file
  npx @skyf0xx/hedgehog next                      print the task packet for one ready task
  npx @skyf0xx/hedgehog show <task-id>            print the task packet for any task, at any status
  npx @skyf0xx/hedgehog claim --owner <owner> [--count <n>]   atomically claim up to n ready tasks
  npx @skyf0xx/hedgehog claim <task-id> --owner <owner>   claim one specific task (breaks a starvation tie)
  npx @skyf0xx/hedgehog retry <task-id>           return a blocked task to planned, so it can be rebuilt
  npx @skyf0xx/hedgehog release <task-id> --owner <owner>   hand a claimed task back to ready
  npx @skyf0xx/hedgehog renew <task-id> --owner <owner> [--minutes <n>]   extend a held lease
  npx @skyf0xx/hedgehog verify <task-id> --owner <owner>   run scope + verify checks, commit on pass
  npx @skyf0xx/hedgehog status                    graph overview: counts by status, ready list, in flight,
                                                   and any drift from core.yaml
  npx @skyf0xx/hedgehog ready                     preview which ready tasks are claimable now vs held back
  npx @skyf0xx/hedgehog quiesce                   report whether anything is still in flight
  npx @skyf0xx/hedgehog boundary                  is this a moment to clear context? exits 0 only if it is,
                                                   and prints what a fresh session picks up next
  npx @skyf0xx/hedgehog boundary --handoff        print the block a fresh session starts from
  npx @skyf0xx/hedgehog boundary --quiet          exit code only, for a shell hook
  npx @skyf0xx/hedgehog graph                     start (or reuse) the live graph server and open it
  npx @skyf0xx/hedgehog graph --no-open           start (or reuse) the server; print the URL instead
  npx @skyf0xx/hedgehog why <path>                provenance chain for a file
  npx @skyf0xx/hedgehog friction add "<note>"     log a friction note [--task <task-id>]
  npx @skyf0xx/hedgehog friction list             list logged friction, oldest first
  npx @skyf0xx/hedgehog debt add <task-id> "<note>"   declare debt that lands in dependent tasks' packets
  npx @skyf0xx/hedgehog debt list [<task-id>]     list declared debt, oldest first
  npx @skyf0xx/hedgehog --help

Available cores: ${cores.join(', ')} (${bold('cores list')} for what each one is for)
Available hosts: ${availableHosts().join(', ')} (default: ${DEFAULT_HOST})

Each core ships as its own package, fetched at install time and cached
under ~/.hedgehog/cores/ so a repeat install of the same version needs no
network. Only the named core's agents and skills land — a project stays
on the toolset its own core defines.

Every command that writes to the build graph prints the absolute path of
the database it opened, and exits non-zero when it matched no task —
which database a relative path resolves to depends on the directory you
ran from.

After it runs, commit the payload, open your coding agent, and describe
what you want to build — the planner agent runs planning intake, then
hands off to bootstrap.

Building something else (a CLI, library, browser extension, data
pipeline, desktop app, etc.)? Run plain 'init' naming no core rather than
picking one by elimination — it installs the agents, skills, and build
graph, the payload every core shares. The planner agent designs a core at
planning intake (hedgehog-core-design) and bootstrap generates that
workspace once it's confirmed. Describe the actual project and let Phase
0 route it.

${bold('update')} re-copies the agents and skills (and the AGENTS.md index
derived from them) from the installed Hedgehog version and from the
project's own core package, so an already-bootstrapped project can pick
up changes from a newer release of either. It refreshes every host the
project was installed for, always overwriting those directories. The
instructions file, the build graph, the core workspace, and the vendored
shelves stay as they are — those are project-specific or updated
deliberately, not by this command.

Both ${bold('init')} and ${bold('update')} stamp the version they wrote into
.hedgehog/version.json. ${bold('update --check')} compares that stamp against
the newest published release and exits 1 when a newer one exists, without
writing anything. The same comparison rides on ${bold('status')} and
${bold('next')} as a one-line notice, from a once-a-day cached lookup, so a
stale project surfaces itself; set HEDGEHOG_NO_UPDATE_CHECK=1 to silence it.
Run ${bold('npx @skyf0xx/hedgehog@latest update')} to pull a newer release —
the @latest tag matters, since a bare npx may reuse a cached older CLI.
`);
}

// `core` is the fetched core — `{ manifest, root, version }` — or null on
// a deferred install, where planner picks one later.
async function init({ force, core, host = DEFAULT_HOST, hostOnly = false }) {
  // Resolve the full list of writes up front so we can detect conflicts
  // before touching anything. A deferred install plans against `null` —
  // the shared agents/skills/build-graph payload only.
  const groups = [];
  for (const entry of plan(core, host, { hostOnly })) {
    const files = await plannedFiles(entry);
    groups.push({ entry, files });
  }

  // A generated file is derived from the payload rather than authored in
  // the project, so rewriting it loses nothing and never counts as a
  // conflict — that's what lets a second host be added to a project the
  // first one already set up.
  const conflicts = [];
  for (const { entry, files } of groups) {
    if (entry.type === 'generated') continue;
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

  // Recorded before anything is written: the routing doc is generated
  // from this list, so it has to already name the host being installed.
  await recordHosts(DEST_ROOT, [host]);
  await recordVersion(DEST_ROOT, PKG_VERSION);
  if (core) await recordCore(DEST_ROOT, { name: core.manifest.name, version: core.version });

  let written = 0;
  let overwritten = 0;
  for (const { files } of groups) {
    for (const f of files) {
      const already = await exists(f.dest);
      await writePlannedFile(f);
      if (already) overwritten++;
      else written++;
      const label = already ? yellow('overwrite') : green('create');
      console.log(`  ${label}  ${relative(DEST_ROOT, f.dest)}`);
    }
  }

  const { created: dbCreated, path: dbPath } = await dbInit(DB_PATH);
  console.log(`  ${dbCreated ? green('create') : dim('exists')}  ${dbPath}`);
  if (dbCreated) written++;

  console.log(
    `\n${green(bold('Hedgehog installed.'))} ${dim(
      `${written} created${overwritten ? `, ${overwritten} overwritten` : ''}`,
    )}\n`,
  );
  console.log('Next steps:');
  // A core that landed a workspace landed its root package.json with it,
  // so there are dependencies to install before the first commit.
  if (core?.manifest.workspace) {
    // `pnpm install` before the first commit, not after it. The core's
    // commit gate is lefthook, and lefthook's hooks are written by its
    // own postinstall — so a commit made before the install is a commit
    // made with no gate at all, and the instruction that put it first
    // was quietly teaching the project to skip its own discipline on
    // the one commit that lands the entire workspace. Installing first
    // means commit #1 is already gated; with no HEAD to diff against it
    // runs the whole workspace (see lefthook.yml), so expect it to take
    // as long as a full typecheck/lint/test — that is the gate working.
    console.log(`  1. ${bold('pnpm install')}`);
    console.log(
      dim('     First run can take several minutes — full dependency install plus'),
    );
    console.log(dim('     the commit gate running against the whole workspace. This is'));
    console.log(dim('     expected; let it finish rather than treating a quiet stretch as stuck.'));
    console.log(
      dim('     If an agent is running this: tell the user up front that first install'),
    );
    console.log(
      dim('     can take several minutes and why, then check on progress every ~30s'),
    );
    console.log(dim('     instead of polling tightly or narrating the wait.'));
    console.log(`  2. ${bold('git add -A && git commit -m "chore: install Hedgehog"')}`);
    console.log(`  3. Describe what you want to build.`);
  } else {
    console.log(`  1. ${bold('git add -A && git commit -m "chore: install Hedgehog"')}`);
    console.log(`  2. Describe what you want to build.`);
  }
  // Hand off by path, not by name. Reading the file works on every host in
  // the session that ran this install — no restart, no dependence on whether
  // the harness re-scans its agent directory, and no chance of a bare
  // `planner` resolving to an unrelated global agent of the same name.
  const agents = HOSTS[host].agentsDir;
  const skills = HOSTS[host].skillsDir;
  console.log(
    dim(
      `     Read ${bold(`${agents}/planner.md`)} and follow it — it runs planning\n` +
        `     intake (${skills}/hedgehog-planning-intake/SKILL.md), then hands\n` +
        `     off to ${agents}/bootstrap.md.`,
    ),
  );
  console.log();
  if (core) {
    console.log(dim(`Core: ${bold(core.manifest.name)} ${dim(`(${core.version})`)}.`));
    console.log(dim('bootstrap runs whichever add-on steps this core defines, if any.'));
  } else {
    console.log(
      dim(
        'Core: not chosen yet — this installed the agents, skills, and\n' +
          'build graph every core shares. planner decides which core applies\n' +
          'at planning intake, then bootstrap generates that core\'s workspace.',
      ),
    );
  }
}

// `update --check` answers the question without acting on it: what's
// installed, what's published, and whether they differ. Exit code 0 when
// current or unknown, 1 when an update is available, so a script or a
// host's own tooling can branch on it without parsing the output.
async function updateCheck() {
  const { installed, latest, stale } = await checkForUpdate(DEST_ROOT, {
    force: true,
  });

  if (!installed) {
    console.log(
      `${yellow('Installed version unknown.')} ${dim(
        'This project predates version stamping — run `hedgehog update` to refresh and stamp it.',
      )}\n`,
    );
    return;
  }
  if (!latest) {
    console.log(
      `Installed: ${bold(installed)}\n${dim(
        "Couldn't reach the npm registry — no update check performed.",
      )}\n`,
    );
    return;
  }
  if (stale) {
    console.log(
      `${yellow(bold('Update available.'))} installed ${bold(installed)} → latest ${bold(latest)}\n\n` +
        `  Run ${bold('npx @skyf0xx/hedgehog@latest update')} to refresh this project's agents and skills.\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${green('Up to date.')} ${dim(`installed ${installed}, latest ${latest}`)}\n`);
}

async function update({ hosts }) {
  const targets = hosts?.length ? hosts : await installedHosts(DEST_ROOT);

  // A project's payload is the engine's agents and skills and its core's,
  // sharing one directory per host. Refreshing that directory means
  // clearing and rewriting it whole, so both halves have to be in hand
  // before anything is removed — refreshing one against a missing other
  // would delete the core's agents and skills with nothing to write back.
  const core = await resolveInstalledCore();
  if (core === UNRESOLVED) {
    process.exitCode = 1;
    return;
  }

  let written = 0;
  for (const host of targets) {
    const entries = updatePlan(host, core);

    // Full replace, not a merge: clear each payload directory first so a
    // rename or removal upstream (e.g. an agent renamed between releases)
    // doesn't leave a stale file sitting alongside the new one. Generated
    // files are single files rewritten in place, so they're left alone.
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await rm(join(DEST_ROOT, entry.to), { recursive: true, force: true });
      }
    }

    for (const entry of entries) {
      for (const f of await plannedFiles(entry)) {
        await writePlannedFile(f);
        written++;
        console.log(`  ${green('update')}  ${relative(DEST_ROOT, f.dest)}`);
      }
    }
  }

  // Stamped after the writes land, so the recorded version always
  // describes the payload actually on disk.
  const previous = await installedVersion(DEST_ROOT);
  await recordVersion(DEST_ROOT, PKG_VERSION);

  const label = targets.map((h) => HOSTS[h].label).join(', ');
  const versionNote =
    previous && previous !== PKG_VERSION
      ? `${previous} → ${PKG_VERSION}`
      : PKG_VERSION;
  console.log(
    `\n${green(bold('Hedgehog agents/skills updated.'))} ${dim(
      `${versionNote} — ${written} files written for ${label}`,
    )}\n`,
  );
  console.log('Next steps:');
  const reviewDirs = [
    ...new Set(
      targets.map((h) => {
        const d = dirname(HOSTS[h].agentsDir);
        return d === '.' ? HOSTS[h].agentsDir : `${d}/`;
      }),
    ),
  ];
  console.log(`  1. ${bold(`git diff ${reviewDirs.join(' ')}`)} to review what changed`);
  console.log(`  2. ${bold('git add -A && git commit -m "chore: update hedgehog"')}\n`);
  const bootstraps = [...new Set(targets.map((h) => HOSTS[h].bootstrapFile))].join(', ');
  console.log(
    dim(
      `${bootstraps}, the build graph, the core workspace, and the\n` +
        'vendored shelves are untouched — those carry project-specific or\n' +
        'write-once content.',
    ),
  );
}

// Returned by resolveInstalledCore when the project has a core but its
// package cannot be produced — distinct from `null`, which means the
// project has no core yet and the shared payload is all there is to
// refresh.
const UNRESOLVED = Symbol('unresolved core');

// A root `core.yaml` is a Golden Core's own file: `corePayload` lands it
// as part of that core's `workspace` at install time, so its presence is
// direct evidence a core package's files are on disk — independent of
// `.hedgehog/core.yaml`, the authored-core path, which is a different
// mechanism with no npm package and no `core.json` record of its own.
// `installedCore` returning null is ambiguous between "no core yet" (a
// deferred install, nothing to detect) and "a core is installed but
// unrecorded"; a root `core.yaml` resolves that ambiguity.
async function detectUnrecordedCore() {
  const rootCorePath = join(DEST_ROOT, 'core.yaml');
  if (!(await exists(rootCorePath))) return null;
  try {
    return (await loadCore(rootCorePath)).id ?? null;
  } catch {
    return null;
  }
}

// The core package `update` should refresh agents and skills from: the
// one this project recorded at install, re-resolved so a newer release of
// that core is picked up, falling back to the extraction already cached
// for the recorded version when the registry is out of reach.
async function resolveInstalledCore() {
  const record = await installedCore(DEST_ROOT);
  if (!record) {
    const unrecordedId = await detectUnrecordedCore();
    if (unrecordedId) {
      console.error(
        `\n${red(bold('Core installed but not recorded:'))} ${bold(unrecordedId)}\n\n` +
          `This project has ${bold(unrecordedId)}'s agents and skills on disk, but nothing\n` +
          `recorded which core they came from — refreshing the payload would rewrite\n` +
          `only what this release plans and delete the rest. Nothing was changed.\n\n` +
          `Run ${bold(`npx @skyf0xx/hedgehog@latest init --core ${unrecordedId} --force`)} to reinstall\n` +
          `${bold(unrecordedId)} from this release and record it, then review ${bold('git diff')} before\n` +
          `committing. Update again afterward.\n`,
      );
      return UNRESOLVED;
    }
    return null;
  }

  const entry = await resolveCore(record.name);
  if (!entry) {
    console.error(
      `\n${red(bold('Core not in this release:'))} ${bold(record.name)}\n\n` +
        `This project's payload includes that core's agents and skills, and refreshing\n` +
        `the payload means rewriting them. This Hedgehog release does not list that\n` +
        `core, so it has nothing to write back and has changed nothing.\n\n` +
        `Run ${bold('npx @skyf0xx/hedgehog@latest update')} for a release that still ships it.\n`,
    );
    return UNRESOLVED;
  }

  try {
    return await fetchCore(entry);
  } catch (err) {
    const cached = record.version ? await cachedCore(entry, record.version) : null;
    if (cached) return cached;
    console.error(
      `\n${red(bold('Core unavailable.'))} ${err.message}\n\n` +
        `Nothing was changed: this project's agents and skills include ${bold(record.name)}'s,\n` +
        `and refreshing them means rewriting them from that package.\n`,
    );
    return UNRESOLVED;
  }
}

async function dbRebuildCommand() {
  const corePath = await resolveCorePath();
  if (!corePath) {
    console.error(
      `${red('No core definition found.')} Expected ${bold(AUTHORED_CORE_PATH)} or a root ${bold('core.yaml')} (from \`hedgehog init\`).\n`,
    );
    process.exitCode = 1;
    return;
  }

  printDbTarget();
  await dbInit(DB_PATH);
  const db = openDb();
  let result;
  try {
    result = await rebuildDb(db, { corePath });
  } finally {
    db.close();
  }

  console.log(
    `${green('rebuilt')}  ${dim(`${result.intentsReplayed} intent(s) replayed, ${result.tasksMarkedComplete} task(s) marked complete`)}\n`,
  );
  warnOrphanedNotes(result);
  warnRebuildDrift(result, corePath);
}

async function dbCommand(args) {
  const sub = args[0];
  if (sub === 'rebuild') {
    await dbRebuildCommand();
    return;
  }
  if (sub !== 'init') {
    console.error(
      `${red('Unknown db subcommand:')} ${sub ?? '(none)'}\n\nUsage: hedgehog db init\n   or: hedgehog db rebuild\n`,
    );
    process.exitCode = 1;
    return;
  }
  printDbTarget();
  const { created, path } = await dbInit(DB_PATH);
  console.log(
    created
      ? `  ${green('create')}  ${path}`
      : `  ${dim('exists')}  ${path} ${dim('(no-op)')}`,
  );
}

// Resolves the project's core definition: an authored .hedgehog/core.yaml
// takes precedence (spec: "Authored cores"); otherwise the Golden Core's
// own core.yaml, which lands at repo root along with the rest of that
// core package's workspace. Neither exists yet on a deferred install
// (plain `init`, no core named) until `bootstrap` runs — this returns
// null until then.
// Synchronous on purpose: formatPacket renders in one pass and takes this
// as a predicate, so the FIRST ARRIVAL check cannot be an await. Paths are
// repo-relative, the same way scope globs are.
function packetExists(path) {
  return existsSync(join(DEST_ROOT, path));
}

async function resolveCorePath() {
  if (await exists(join(DEST_ROOT, AUTHORED_CORE_PATH))) {
    return join(DEST_ROOT, AUTHORED_CORE_PATH);
  }
  const rootCore = join(DEST_ROOT, 'core.yaml');
  if (await exists(rootCore)) return rootCore;
  return null;
}

// The active core's `id` (e.g. `full-stack-app`), or null when no core has
// landed yet or it fails to parse — packet rendering degrades gracefully
// either way (see next.mjs's layerShapeLines), so a caller only asking for
// the id doesn't need its own try/catch.
async function resolveCoreId() {
  const corePath = await resolveCorePath();
  if (!corePath) return null;
  try {
    return (await loadCore(corePath)).id;
  } catch {
    return null;
  }
}

// `hedgehog plan --recompile` — the reconciliation path for a core.yaml
// edited after `plan` already compiled it.
//
// `plan` copies each layer's scope globs, verify command, commit message,
// exclusivity and verify radius onto every task row, and from then on the
// row is what `next`/`claim`/`verify` read. A plain re-run can't fix a
// later core.yaml correction — compiling an intent flips it to `active`,
// and `plan` only ever looks at `proposed`/`planned` ones — so before this
// existed the only remedy was an UPDATE in SQLite by hand.
//
// Deliberately not a fresh compile: it rewrites fields on tasks nothing
// has acted on yet and refuses the rest, so ids, dependencies, statuses
// and history are untouched.
async function planRecompileCommand(args, { core, corePath }) {
  const includeBlocked = args.includes('--include-blocked');
  const dryRun = args.includes('--dry-run');
  const strict = args.includes('--strict');
  const overrides = await loadOverrides();

  const db = openDb();
  let result;
  try {
    result = recompileTasks(db, core, { includeBlocked, dryRun, overrides });
  } finally {
    db.close();
  }

  if (dryRun) console.log(dim('  (--dry-run — nothing was written)'));
  console.log(formatRecompile(result));

  if (result.updated.length === 0 && result.skipped.length === 0) {
    console.log(`\n${green(bold('In sync.'))} Every task matches ${bold(corePath)}.\n`);
    return;
  }

  if (result.skipped.length > 0) {
    console.log(
      `\n${yellow(bold('Some drift remains.'))} Each skipped task above names why it kept its compiled\n` +
        'fields. A task already built, leased, or committed is a Correction Protocol\n' +
        'case (fix the layer at its source, re-run that layer), not a field rewrite;\n' +
        'a changed depends_on or a layer dropped from core.yaml is a graph-shape\n' +
        'change, which --recompile deliberately does not make.\n',
    );
  } else {
    console.log(`\n${green(bold('Recompiled.'))}\n`);
  }

  if (strict && result.skipped.length > 0) process.exitCode = 1;
}

// `hedgehog plan [--open|--no-open]` — compiles pending intents.
//
// Starting the live graph server is opt-in (`--open`), not automatic.
// Hedgehog's primary caller is an agent in a headless session: there is
// no browser for `openInBrowser` to hand the URL to, so the old
// unconditional `startOrReuseGraphServer()` bought nothing and cost a
// detached `node` process left listening on 127.0.0.1 with an open
// handle on the build graph, plus a `.hedgehog/graph-server.json`
// pidfile outliving the command that wrote it. `hedgehog graph` is the
// one command whose *purpose* is that server; `plan`'s purpose is
// compiling the graph, and it now exits having started nothing.
//
// `--no-open` is accepted for symmetry with `hedgehog graph` and names
// the default explicitly. It differs from `graph --no-open` in one way
// that follows from the same principle: on `graph` the server is the
// point and only the browser is suppressed, whereas on `plan` the
// server exists solely to be opened, so suppressing the open leaves
// nothing worth serving — no server, no pidfile, no orphan.
async function planCommand(args = []) {
  await ensureDb();

  const wantsOpen = args.includes('--open');
  if (wantsOpen && args.includes('--no-open')) {
    console.error(`${red('Usage:')} hedgehog plan takes --open or --no-open, not both\n`);
    process.exitCode = 1;
    return;
  }

  const corePath = await resolveCorePath();
  if (!corePath) {
    console.error(
      `${red('No core definition found.')} Expected ${bold(AUTHORED_CORE_PATH)} or a root ${bold('core.yaml')} (from \`hedgehog init\`).\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();
  const core = await loadCore(corePath);

  if (args.includes('--recompile')) {
    await planRecompileCommand(args, { core, corePath });
    return;
  }

  const overrides = await loadOverrides();
  const db = openDb();
  let result;
  try {
    result = planTasks(db, core, overrides);
  } finally {
    db.close();
  }

  for (const id of result.once) {
    console.log(`  ${green('compiled')}  ${id} ${dim('(once — one task for the whole build)')}`);
  }
  for (const id of result.compiled) console.log(`  ${green('compiled')}  ${id}`);
  for (const id of result.skipped) console.log(`  ${dim('skipped')}  ${id} ${dim('(already compiled)')}`);
  for (const id of result.reopened) {
    console.log(
      `  ${bold('reopened')}  ${id} ${dim('(once — new scope landed under it; it must run again)')}`,
    );
  }
  console.log(
    `\n${green(bold('Plan complete.'))} ${dim(`${result.compiled.length} intent(s) compiled, ${result.skipped.length} skipped`)}\n`,
  );

  // A plain `plan` is where someone lands after editing core.yaml,
  // expecting the edit to take. It won't — already-compiled tasks carry
  // their own copy of the layer's fields — so say so here rather than
  // letting the run report "0 compiled" and look like a no-op.
  const driftDb = openDb({ readOnly: true });
  let drifted;
  try {
    warnSingularModuleIdsAtPlan(core, driftDb);
    drifted = detectDrift(driftDb, core, { overrides });
  } finally {
    driftDb.close();
  }
  if (drifted.length > 0) {
    console.log(
      `${yellow(bold('Core drift.'))} ${drifted.length} already-compiled task(s) no longer match ${bold(corePath)}.\n` +
        `Compiling does not revisit them. Run ${bold('hedgehog status')} to see the divergence,\n` +
        `or ${bold('hedgehog plan --recompile')} to rewrite the not-started ones.\n`,
    );
  }

  // Only worth opening when this run actually changed the graph's shape
  // — a plan run that compiled nothing (every intent already had tasks)
  // would just re-open what's already open.
  if (result.compiled.length === 0) return;

  if (!wantsOpen) {
    console.log(`${dim('Run')} ${bold('hedgehog graph')} ${dim('to view the build graph.')}\n`);
    return;
  }

  // planTasks's own db handle is closed by this point: the graph server
  // opens its own connection in a separate process, and holding two
  // write-capable handles on the same sqlite file across that handoff
  // invites lock contention for no benefit.
  const { port } = await startOrReuseGraphServer();
  presentGraphUrl(`http://localhost:${port}`);
}

// Parses `hedgehog intent add` args into the same record shape
// src/db/intent.mjs#normalizeIntent expects. Two sources: `--file <path>`
// (a JSON file matching the intent record shape verbatim), or flags —
// `--id`, `--goal`, `--outcome`, `--priority`, repeatable `--rule`
// / `--constraint` / `--acceptance` / `--depends-on`. Mixing the two
// is rejected: one intent, one unambiguous source.
async function parseIntentArgs(args) {
  const fileIdx = args.indexOf('--file');
  const hasFlags = args.some((a) => a.startsWith('--') && a !== '--file');

  if (fileIdx !== -1) {
    if (hasFlags) {
      throw new Error('--file cannot be combined with other intent flags');
    }
    const filePath = args[fileIdx + 1];
    if (!filePath) throw new Error('--file requires a path');
    const text = await readFile(resolve(DEST_ROOT, filePath), 'utf8');
    return JSON.parse(text);
  }

  const record = { rules: [], constraints: [], acceptance: [], depends_on: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case '--id':
        record.id = value;
        i++;
        break;
      case '--goal':
        record.goal = value;
        i++;
        break;
      case '--outcome':
        record.outcome = value;
        i++;
        break;
      case '--priority':
        record.priority = Number(value);
        i++;
        break;
      case '--rule':
        record.rules.push(value);
        i++;
        break;
      case '--constraint':
        record.constraints.push(value);
        i++;
        break;
      case '--acceptance':
        record.acceptance.push(value);
        i++;
        break;
      case '--depends-on':
        record.depends_on.push(value);
        i++;
        break;
      default:
        throw new Error(`Unknown intent flag: ${flag}`);
    }
  }
  return record;
}

async function intentCommand(args) {
  await ensureDb();

  const sub = args[0];
  if (sub !== 'add') {
    console.error(
      `${red('Unknown intent subcommand:')} ${sub ?? '(none)'}\n\nUsage: hedgehog intent add --id <id> --goal <goal> --outcome <outcome> [--rule <r>]... [--depends-on <id>]...\n   or: hedgehog intent add --file <path.json>\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  let record;
  try {
    record = await parseIntentArgs(args.slice(1));
  } catch (err) {
    console.error(`${red('Invalid arguments:')} ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();
  const db = openDb();
  let intent;
  try {
    intent = await addIntent(db, record);
  } catch (err) {
    console.error(`${red('Failed to add intent:')} ${err.message}\n`);
    process.exitCode = 1;
    return;
  } finally {
    db.close();
  }

  console.log(`  ${green('added')}  ${intent.id}`);
  console.log(`  ${dim(`${intent.requirements.length} requirement(s), ${intent.depends_on.length} dependency(ies)`)}`);
  await warnSingularModuleId(intent);
}

// On a module-axis core the intent id becomes {module} in every layer's
// scope glob and verify command, and the generators the packet points at
// take the module name plural. A singular id compiles a whole graph
// scoped to a directory the generator will never write, and nothing
// downstream catches it: plan compiles it, claim hands out a packet whose
// own scaffold command contradicts its ALLOWED SCOPE.
//
// A warning rather than a refusal: plenty of real modules are singular
// (`billing`, `search`), so the convention cannot be enforced without
// rejecting correct ids. Raised here because this is the last moment the
// fix is one file rename — three layers later it is a Correction Protocol
// case across every compiled task.
//
// The convention is a heuristic, not a checkable property of the graph:
// `tasks` and `task` are both structurally valid, and nothing downstream
// knows which one the generator wants. So this only ever reports.
function looksSingular(id) {
  return !/(s|ae|ia|people|children)$/i.test(id);
}

// `intent add` is one route to the compiler among several — `--file`, a
// hand-written intents/*.json, and `db rebuild` all reach it without
// passing through here — so `plan` re-raises the same check where every
// route converges. See planCommand.
async function warnSingularModuleId(intent) {
  const corePath = await resolveCorePath();
  if (!corePath) return;

  let core;
  try {
    core = await loadCore(corePath);
  } catch {
    // A core that will not load is `plan`'s error to report, not this
    // advisory's.
    return;
  }
  if (!isModuleAxis(core)) return;
  if (!looksSingular(intent.id)) return;

  console.log(
    `\n${yellow(bold('Module id looks singular.'))} On this core the intent id is ${bold('{module}')} in\n` +
      `every layer's scope, and the generators take it plural — so ${bold(intent.id)} compiles\n` +
      `scope for ${bold(`${intent.id}/`)} while the scaffold command writes ${bold(`${intent.id}s/`)}.\n` +
      `If ${bold(`${intent.id}s`)} is the name you meant, fix it now, before ${bold('hedgehog plan')}:\n` +
      `  ${dim(`git mv ${INTENTS_DIR}/${intent.id}.json ${INTENTS_DIR}/${intent.id}s.json`)}\n` +
      `  ${dim(`# edit "id" and every ${intent.id.toUpperCase()}-* requirement id, then:`)}\n` +
      `  ${dim('hedgehog db rebuild')}\n`,
  );
}

// The same advisory at `plan`, where `--file`, a hand-written intent
// file, and `db rebuild` all converge — none of them passes through
// `intent add`, so on those routes this is the first and last cheap
// warning before a whole graph is compiled against the id. It reports
// while every one of an intent's tasks is still unstarted; once work has
// landed the fix is a Correction Protocol case rather than a rename, and
// repeating the `git mv` advice would point at the wrong recovery.
//
// One block for however many ids trip it, rather than repeating the
// per-intent explanation: the reasoning is identical every time, and
// stacking it once per intent buries the list of names under it. The
// recovery is still per-id, so those lines are listed one per name.
function warnSingularModuleIdsAtPlan(core, db) {
  if (!isModuleAxis(core)) return;

  // Every intent whose tasks have all yet to start, not just the ones
  // this run compiled. `db rebuild` replays the committed intent files
  // *and* compiles their tasks, so a `plan` after it compiles nothing —
  // and that is precisely the route where nothing else has ever looked at
  // the id. The cheap-fix window is "no work has landed yet", which
  // outlasts any single `plan` invocation.
  const singular = db
    .prepare(
      `SELECT i.id FROM intents i
        WHERE i.id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.intent_id = i.id
               AND t.status NOT IN ('proposed','planned','ready')
          )
        ORDER BY i.id`,
    )
    .all(CORE_INTENT_ID)
    .map((row) => row.id)
    .filter(looksSingular);
  if (singular.length === 0) return;

  const many = singular.length > 1;
  console.log(
    `${yellow(bold(many ? `${singular.length} module ids look singular.` : 'Module id looks singular.'))} ` +
      `On this core an intent id is ${bold('{module}')} in\n` +
      `every layer's scope, and the generators take it plural — so ${many ? 'each of these compiles' : 'this compiles'}\n` +
      `scope for a directory the scaffold command will never write:\n` +
      singular.map((id) => `  ${bold(id)} ${dim(`— scope ${id}/, scaffold writes ${id}s/`)}`).join('\n') +
      `\n\nThis is a naming convention, not a rule — ${bold('billing')} and ${bold('search')} are ` +
      `legitimately\nsingular. If the plural is what you meant, it is still cheap to fix:\n` +
      singular
        .map(
          (id) =>
            `  ${dim(`git mv ${INTENTS_DIR}/${id}.json ${INTENTS_DIR}/${id}s.json`)}\n` +
            `  ${dim(`# edit "id" and every ${id.toUpperCase()}-* requirement id`)}`,
        )
        .join('\n') +
      `\n  ${dim('hedgehog db rebuild')}\n`,
  );
}

// The passive half of update detection. Printed to stderr, after a
// command's real output, on the commands every host's loop runs anyway —
// so a stale project surfaces itself without anyone thinking to ask.
//
// This lives in the CLI rather than in any one host's hook because every
// host drives the same binary: Claude Code, Cursor, and Gemini CLI all
// reach it through `hedgehog next`, and one implementation here covers
// all of them.
//
// Never throws and never blocks: the answer comes from a day-long cache,
// a missing or unreachable registry reads as "no news", and the notice is
// skipped entirely when output isn't a terminal so it can't corrupt
// anything parsing stdout.
async function noteAvailableUpdate() {
  if (process.env.HEDGEHOG_NO_UPDATE_CHECK) return;
  try {
    const { installed, latest, stale } = await checkForUpdate(DEST_ROOT);
    if (!stale) return;
    console.error(
      `\n${yellow(bold('Hedgehog update available.'))} ${dim(
        `${installed} → ${latest}. Run \`npx @skyf0xx/hedgehog@latest update\` to refresh this project's agents and skills.`,
      )}`,
    );
  } catch {
    // Advisory only — a failed check is never worth failing a command over.
  }
}

async function nextCommand() {
  await ensureDb();

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  let packet;
  let stalled;
  try {
    packet = nextTask(db);
    stalled = stalledTasks(db);
  } finally {
    db.close();
  }

  if (!packet) {
    // A stalled task is not pickable, so without naming it here "no ready
    // task" reads identically whether the build is finished or wedged on
    // a failed verification.
    if (stalled.length > 0) {
      console.error(`${red(bold('No ready task, but the graph is blocked.'))}\n`);
      printStalledTasks(stalled);
      // `verify` refuses anything that isn't `building` and leased to
      // the caller, so a blocked task has to go back through the queue
      // — retry, claim, then verify — rather than straight to verify.
      console.error(
        `\nFix the work, then ${bold('hedgehog retry <task-id>')} and claim it again.\n`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${dim('No ready task.')} Nothing is planned with all dependencies complete.\n`);
    await noteAvailableUpdate();
    return;
  }

  // A blocked task elsewhere in the graph doesn't stop this ready task
  // from being handed out — leases are scoped to disjoint work, so an
  // unrelated block is no reason to halt everything else. But it's easy
  // to miss otherwise: the queue keeps producing ready tasks right up
  // until it doesn't, and a block can sit unnoticed the whole time. This
  // warns without withholding the packet.
  if (stalled.length > 0) {
    console.error(`${yellow(bold(`${stalled.length} task(s) blocked elsewhere in the graph:`))}`);
    printStalledTasks(stalled);
    console.error('');
  }

  console.log(formatNext(packet, await resolveCoreId(), packetExists));
  await noteAvailableUpdate();
}

function printStalledTasks(stalled) {
  for (const task of stalled) {
    const reason = BLOCKED_REASON_LABELS[task.blocked_reason] ?? task.blocked_reason;
    console.error(`  ${red('✗')} ${bold(task.id)}   ${task.layer}   ${dim(reason)}`);
  }
}

// Mirrors, read-only, the condition verifyTask's own Phase 0
// (claimForVerify) enforces: after expired leases are reaped, the task
// must be `building` and leased to `owner`. The expiry predicate is
// claim.mjs#reapExpiredLeases's, kept identical so this can't disagree
// with the check it's standing in for. Writes nothing and reaps nothing
// — the authoritative check, with its state changes, stays in verify.mjs.
const VERIFIABLE_BY_SQL = `
  SELECT 1 FROM tasks
  WHERE id = ? AND status = 'building' AND lease_owner = ?
    AND (lease_expires_at IS NULL OR lease_expires_at >= datetime('now'))
`;

function taskVerifiableBy(db, taskId, owner) {
  return db.prepare(VERIFIABLE_BY_SQL).get(taskId, owner) !== undefined;
}

// The declared-binary gate for one task: resolves the task's layer in
// the core definition and returns { layer, missing } when that layer's
// `requires:` names binaries this environment can't find, or null when
// there's nothing to say (no core, unknown task/layer, nothing missing).
//
// Runs ahead of verifyTask so the verify command is never handed to a
// shell that will answer `exit 127` with no context. Deliberately makes
// no state change: the task keeps its lease and its `building` status,
// so installing the binary and re-running `hedgehog verify` is the whole
// fix — no unblocking step, and no failed verification recorded for
// something that never ran.
//
// It only speaks for a caller who could actually verify this task. A
// caller holding no lease, or a stale one, has a different problem, and
// telling them to install a binary would send them off to fix something
// that isn't in their way — so this stays quiet and lets verifyTask
// report the real ownership/state error. Nothing is lost by deferring:
// claimForVerify throws before any verify command runs, so falling
// through still records no failed verification.
async function missingBinariesForTask(db, taskId, owner) {
  if (!taskVerifiableBy(db, taskId, owner)) return null;

  const row = db.prepare('SELECT layer FROM tasks WHERE id = ?').get(taskId);
  if (row === undefined) return null;

  const corePath = await resolveCorePath();
  if (!corePath) return null;

  let core;
  try {
    core = await loadCore(corePath);
  } catch {
    // An unloadable core.yaml is `plan`'s error to report; don't turn it
    // into a confusing failure of an unrelated verify.
    return null;
  }

  const layer = core.layers.find((l) => l.id === row.layer);
  if (!layer) return null;

  const missing = missingBinaries(layer.requires);
  return missing.length === 0 ? null : { layer: layer.id, missing };
}

// What an out-of-scope path most likely is, and what to do about it.
// "Outside allowed scope" is true of every offending path and tells the
// reader nothing about which of three quite different situations they're
// in: a package shell the layer itself had to create (widen this one
// task), shared config a source-level fix touched (commit it separately),
// or a genuine stray. Each wants a different next move, and working out
// which costs a beat every time.
//
// Evidence-only, like core.mjs's lint: an unrecognised path gets no
// annotation rather than a guessed one.
const SCOPE_HINTS = [
  {
    // A package root's own scaffolding — package.json, tsconfig*.json,
    // vitest.config.mts, src/index.ts directly under packages/<pkg>/ or
    // libs/<a>/<b>/. No {module}-bearing scope glob can cover these, so
    // the first module through a layer that creates its package always
    // lands here.
    test: (p) =>
      /^(packages\/[^/]+|libs\/[^/]+\/[^/]+)\/(package\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?ts|project\.json|eslint\.config\.[cm]?js|src\/index\.ts)$/.test(
        p,
      ),
    hint: 'package shell — if this layer is the first to create this package, widen just this task with `hedgehog override add` (see hedgehog-loop, "First arrival in a package") and retry',
  },
  {
    test: (p) =>
      p === 'pnpm-workspace.yaml' ||
      p === 'pnpm-lock.yaml' ||
      p === 'tsconfig.json' ||
      p === 'nx.json' ||
      p === 'package.json' ||
      p.startsWith('packages/config/'),
    hint: 'shared workspace config — no layer owns it; commit it separately as its own `chore(workspace): …` before retrying',
  },
  {
    test: (p) => p.startsWith('.hedgehog/'),
    hint: 'build-graph state — intents, overrides and friction are committed by the command that writes them, not by a layer',
  },
];

function scopeHintFor(path) {
  return SCOPE_HINTS.find((h) => h.test(path))?.hint ?? null;
}

async function verifyCommand(args) {
  await ensureDb();

  const taskId = args[0];
  const ownerIdx = args.indexOf('--owner');
  const owner = ownerIdx !== -1 ? args[ownerIdx + 1] : undefined;
  if (!taskId || !owner) {
    console.error(`${red('Usage:')} hedgehog verify <task-id> --owner <owner>\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();
  const db = openDb();
  let result;
  try {
    const blockers = await missingBinariesForTask(db, taskId, owner);
    if (blockers) {
      const list = blockers.missing.map((b) => bold(b)).join(', ');
      console.error(
        `${red(bold('Missing required binaries.'))} Task ${bold(taskId)} (layer ${bold(blockers.layer)}) was not verified.\n`,
      );
      console.error(`Not found on PATH: ${list}`);
      console.error(
        `${dim(`Declared by layer "${blockers.layer}" in core.yaml (requires:). The verify command was not run.`)}`,
      );
      console.error(
        `${dim('Install them, or put them on the PATH of the shell running hedgehog — an interactive login shell may see binaries a non-interactive one does not — then re-run this command.')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    result = verifyTask(db, taskId, owner);
  } catch (err) {
    console.error(`${red('Verify failed:')} ${err.message}\n`);
    process.exitCode = 1;
    return;
  } finally {
    db.close();
  }

  if (result.outcome === 'scope_violation') {
    console.error(`${red(bold('Scope violation.'))} Task ${bold(taskId)} is now ${bold('blocked')}.\n`);
    console.error('Touched paths outside allowed scope:');
    for (const path of result.offending) {
      console.error(`  ${red('✗')} ${path}`);
      const hint = scopeHintFor(path);
      if (hint) console.error(`      ${dim(hint)}`);
    }
    console.error();
    process.exitCode = 1;
    return;
  }

  if (result.outcome === 'failed') {
    console.error(`${red(bold('Verification failed.'))} Task ${bold(taskId)} is now ${bold('blocked')} (exit ${result.exitCode}).\n`);
    if (result.output) console.error(result.output);
    process.exitCode = 1;
    return;
  }

  console.log(`${green(bold('Verified.'))} Task ${bold(taskId)} is now ${bold('complete')}.`);
  if (result.commitSha) console.log(`  ${dim('commit')}  ${result.commitSha}`);
  if (result.unlocked.length === 0) {
    console.log(`  ${dim('no dependents unlocked')}`);
  } else {
    for (const id of result.unlocked) console.log(`  ${green('ready')}  ${id}`);
  }
  if (result.intentComplete) {
    console.log(`  ${green('intent complete')}  ${dim('every task for this intent is done')}`);
  }

  // The one comparison in the circuit. Each layer's verify_command runs
  // the tests that layer itself wrote, so it measures internal
  // consistency and never coverage of what was asked — a layer that
  // builds half an intent and tests that half exhaustively is green.
  // Closing the last layer is the moment the intent is claimed done, so
  // that is where what was requested gets printed back to be read against
  // what was built. It is not a machine-checkable gate; it cannot be. Its
  // value is that the comparison happens at all, once.
  if (result.completedIntent) {
    const { id, goal, outcome } = result.completedIntent;
    console.log('');
    console.log(`${bold('INTENT CHECK')}  ${bold(id)}  ${dim('— this closed the last layer of this intent.')}`);
    console.log(`  ${dim('GOAL')}     ${goal}`);
    console.log(`  ${dim('OUTCOME')}  ${outcome}`);
    console.log('');
    console.log(dim('  Confirm the work built across this intent\'s layers covers the above.'));
    console.log(dim('  Anything asked for and not built is a Correction Protocol case now,'));
    console.log(dim('  not a later discovery. Nothing else in the build checks this.'));
    console.log('');
  }
}

// Prints the full task packet for each task in `tasks`, read back from
// the graph after the claim landed. Claiming moves a task to `building`,
// which takes it out of `hedgehog next`'s candidate set — so if claim
// doesn't print the packet here, the STATUS/ALLOWED SCOPE/VERIFICATION an
// agent is supposed to be dispatched with is no longer reachable from any
// command. (`hedgehog show <task-id>` reprints it later.)
async function printPackets(tasks) {
  const coreId = await resolveCoreId();
  const db = openDb();
  try {
    for (const task of tasks) {
      const packet = taskPacket(db, task.id);
      if (!packet) continue;
      console.log();
      console.log(formatPacket(packet, taskStatusLine(packet.task), coreId, packetExists));
    }
  } finally {
    db.close();
  }
  console.log();
}

// `hedgehog claim [<task-id>] --owner <owner> [--count <n>]` — atomically
// claims up to `count` mutually non-conflicting ready tasks (claimTasks's
// fan-out, item 13), or the one named task, and prints each claimed
// task's full packet plus which owner now holds it.
async function claimCommand(args) {
  await ensureDb();

  // A leading non-flag argument names one specific task; without it this
  // is the fan-out claim it has always been.
  const taskId = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const ownerIdx = args.indexOf('--owner');
  const owner = ownerIdx !== -1 ? args[ownerIdx + 1] : undefined;
  const countIdx = args.indexOf('--count');
  const count = countIdx !== -1 ? Number(args[countIdx + 1]) : 1;
  if (!owner) {
    console.error(
      `${red('Usage:')} hedgehog claim --owner <owner> [--count <n>]\n   or: hedgehog claim <task-id> --owner <owner>\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (taskId && countIdx !== -1) {
    console.error(`${red('--count cannot be combined with a task id')} — a targeted claim takes exactly one task.\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();

  if (taskId) {
    await claimOneCommand(taskId, owner);
    return;
  }

  const db = openDb();
  let claimed, blocked;
  try {
    ({ claimed, blocked } = claimTasks(db, { owner, count }));
  } finally {
    db.close();
  }

  // Stop-the-line: claimTasks refuses the whole batch, in any module,
  // while any task anywhere is blocked — see its own comment in
  // claim.mjs. A targeted `hedgehog claim <task-id>` is unaffected, which
  // is how the blocked task itself gets reclaimed after `hedgehog retry`.
  if (blocked.length > 0) {
    console.error(`${red(bold('Claim refused.'))} ${blocked.length} task(s) blocked:\n`);
    for (const task of blocked) {
      const reason = BLOCKED_REASON_LABELS[task.blocked_reason] ?? task.blocked_reason;
      console.error(`  ${red('✗')} ${bold(task.id)}   ${task.layer}   ${dim(reason)}`);
    }
    console.error(
      `\nFix the work, then ${bold('hedgehog retry <task-id>')} before claiming more.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (claimed.length === 0) {
    console.log(`${dim('No claimable task.')} Nothing is ready with no lease held.\n`);
    return;
  }

  if (claimed.length > 1) {
    console.log(`${green(bold('Claimed.'))} ${claimed.length} task(s) to ${bold(owner)}.`);
  } else {
    console.log(`${green(bold('Claimed.'))} Task ${bold(claimed[0].id)} leased to ${bold(owner)}.`);
  }
  for (const task of claimed) {
    if (claimed.length > 1) console.log(`  ${bold(task.id)}`);
    console.log(`  ${dim('expires')}  ${task.lease_expires_at}`);
  }
  await printPackets(claimed);
}

// The targeted half of `claim`: one named task, or a non-zero exit
// naming which precondition refused it. Never exits 0 without having
// claimed something — an operator breaking a starvation tie has to be
// able to tell "claimed" from "matched nothing" by exit code alone.
async function claimOneCommand(taskId, owner) {
  const db = openDb();
  let result;
  try {
    result = claimTask(db, taskId, { owner });
  } finally {
    db.close();
  }

  if (result.claimed) {
    console.log(`${green(bold('Claimed.'))} Task ${bold(taskId)} leased to ${bold(owner)}.`);
    console.log(`  ${dim('expires')}  ${result.task.lease_expires_at}`);
    await printPackets([result.task]);
    return;
  }

  process.exitCode = 1;

  if (result.reason === 'no_such_task') {
    console.error(`${red('No such task:')} ${bold(taskId)}${dim(` (in ${dbAbsPath()})`)}\n`);
    return;
  }
  if (result.reason === 'not_claimable') {
    const held = result.task.lease_owner ? `, leased to ${result.task.lease_owner}` : '';
    console.error(
      `${red('Not claimable.')} Task ${bold(taskId)} is ${bold(result.task.status)}${held}.\n` +
        (result.task.status === 'blocked'
          ? `\nReturn it to the queue first: ${bold(`hedgehog retry ${taskId}`)}\n`
          : '\n'),
    );
    return;
  }
  if (result.reason === 'incomplete_dependencies') {
    console.error(`${red('Not claimable.')} Task ${bold(taskId)} is waiting on:\n`);
    for (const dep of result.incomplete) {
      console.error(`  ${red('✗')} ${bold(dep.id)}   ${dep.layer}   ${dep.status}`);
    }
    console.error();
    return;
  }
  if (result.reason === 'conflict') {
    console.error(`${red('Not claimable.')} Task ${bold(taskId)} conflicts with work in flight:\n`);
    for (const { task, kind } of result.conflicting) {
      console.error(`  ${red('✗')} ${bold(task.id)}   ${task.status}   ${dim(`(${kind})`)}`);
    }
    console.error(
      `\nWait for those to finish, or ${bold('hedgehog release')} them, then claim again.\n`,
    );
    return;
  }
  console.error(`${red('Not claimed.')} A concurrent claim took ${bold(taskId)} first.\n`);
}

// `hedgehog retry <task-id>` — the transition out of `blocked`, for any
// blocked_reason. A failed verification and a scope violation are the
// loop's normal failure cases, but `release` only accepts `building` and
// `verify` only accepts a task leased to the caller, so before this
// command a blocked task had no CLI path back into the queue at all.
async function retryCommand(args) {
  await ensureDb();

  const taskId = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  if (!taskId) {
    console.error(`${red('Usage:')} hedgehog retry <task-id> [--owner <owner>]\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();

  const db = openDb();
  let result;
  try {
    result = retryTask(db, taskId);
  } finally {
    db.close();
  }

  if (!result.retried) {
    process.exitCode = 1;
    if (result.reason === 'no_such_task') {
      console.error(`${red('No such task:')} ${bold(taskId)}${dim(` (in ${dbAbsPath()})`)}\n`);
      return;
    }
    console.error(
      `${red('Not retried.')} Task ${bold(taskId)} is ${bold(result.task.status)}, not ${bold('blocked')}.\n`,
    );
    return;
  }

  const reason = BLOCKED_REASON_LABELS[result.from] ?? result.from;
  console.log(
    `${green(bold('Retried.'))} Task ${bold(taskId)} is back to ${bold('planned')} ${dim(`(was blocked: ${reason})`)}`,
  );
  console.log(`  ${dim('claim it with')}  hedgehog claim ${taskId} --owner <owner>`);
}

// `hedgehog show <task-id>` — the same packet `next` prints, for a task
// named by id whatever its status. Read-only: claims nothing, changes
// nothing.
async function showCommand(args) {
  await ensureDb();

  const taskId = args[0];
  if (!taskId) {
    console.error(`${red('Usage:')} hedgehog show <task-id>\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  let packet;
  try {
    packet = taskPacket(db, taskId);
  } finally {
    db.close();
  }

  if (!packet) {
    console.error(`${red('No such task:')} ${bold(taskId)}${dim(` (in ${dbAbsPath()})`)}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(
    formatPacket(packet, taskStatusLine(packet.task), await resolveCoreId(), packetExists),
  );
}

// `hedgehog release <task-id> --owner <owner>` — hands a claimed task
// back to `ready` without marking it blocked, for an agent stopping
// cleanly before finishing.
async function releaseCommand(args) {
  await ensureDb();

  const taskId = args[0];
  const ownerIdx = args.indexOf('--owner');
  const owner = ownerIdx !== -1 ? args[ownerIdx + 1] : undefined;
  if (!taskId || !owner) {
    console.error(`${red('Usage:')} hedgehog release <task-id> --owner <owner>\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();

  const db = openDb();
  let result;
  try {
    result = releaseTask(db, taskId, owner);
  } finally {
    db.close();
  }

  if (!result.released) {
    process.exitCode = 1;
    if (result.reason === 'no_such_task') {
      console.error(`${red('No such task:')} ${bold(taskId)}${dim(` (in ${dbAbsPath()})`)}\n`);
      return;
    }
    console.error(
      `${red('Not released.')} Task ${bold(taskId)} is ${bold(result.task.status)}${
        result.task.lease_owner ? `, leased to ${bold(result.task.lease_owner)}` : ''
      } — not ${bold('building')} under ${bold(owner)}.\n` +
        (result.task.status === 'blocked'
          ? `\nReturn a blocked task to the queue with: ${bold(`hedgehog retry ${taskId}`)}\n`
          : ''),
    );
    return;
  }

  console.log(`${green(bold('Released.'))} Task ${bold(taskId)} is now ${bold('ready')}.`);
}

// `hedgehog renew <task-id> --owner <owner> [--minutes <n>]` — extends a
// held lease, for an agent still working past the original lease window.
async function renewCommand(args) {
  await ensureDb();

  const taskId = args[0];
  const ownerIdx = args.indexOf('--owner');
  const owner = ownerIdx !== -1 ? args[ownerIdx + 1] : undefined;
  const minutesIdx = args.indexOf('--minutes');
  const minutes = minutesIdx !== -1 ? Number(args[minutesIdx + 1]) : 45;
  if (!taskId || !owner) {
    console.error(`${red('Usage:')} hedgehog renew <task-id> --owner <owner> [--minutes <n>]\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  printDbTarget();

  const db = openDb();
  let result;
  try {
    result = renewLease(db, taskId, owner, minutes);
  } finally {
    db.close();
  }

  if (!result.renewed) {
    process.exitCode = 1;
    if (result.reason === 'no_such_task') {
      console.error(`${red('No such task:')} ${bold(taskId)}${dim(` (in ${dbAbsPath()})`)}\n`);
      return;
    }
    console.error(
      `${red('Not renewed.')} Task ${bold(taskId)} is ${bold(result.task.status)}${
        result.task.lease_owner ? `, leased to ${bold(result.task.lease_owner)}` : ''
      } — not leased to ${bold(owner)}.\n`,
    );
    return;
  }

  console.log(`${green(bold('Renewed.'))} Task ${bold(taskId)}'s lease extended by ${minutes} minute(s).`);
}

// Heuristic problems with the project's own core definition, rendered for
// `hedgehog status`. Surfaced here because status is the command every
// session starts with, and a core-definition smell is a build-wide fact
// rather than one task's: a layer whose verify command doesn't reach the
// verify_radius it declared lets a task break a neighbour and still
// commit green, and nothing later in the loop will say so. Warnings only
// — the certainties throw from validateCore, on load.
async function coreWarningLines() {
  const corePath = await resolveCorePath();
  if (!corePath) return [];
  const label = relative(DEST_ROOT, corePath) || corePath;
  let core;
  try {
    core = await loadCore(corePath);
  } catch (err) {
    // Every other command that loads the core fails outright on this; say
    // so here rather than letting `hedgehog status` die with a stack.
    return ['', `${red('CORE')}  ${bold(label)} is invalid: ${err.message}`];
  }
  const warnings = lintCore(core);
  if (warnings.length === 0) return [];
  return [
    '',
    `${yellow('CORE WARNINGS')}  ${dim(label)}`,
    ...warnings.map((warning) => `  ${yellow('!')} ${warning}`),
  ];
}

async function statusCommand() {
  await ensureDb();

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  // Drift needs the core definition to compare against. A project
  // without one yet (deferred install, pre-bootstrap) simply gets the
  // status it always got; an unparseable one is reported but never
  // allowed to take `status` down — it's the command every session
  // starts with.
  let core = null;
  const corePath = await resolveCorePath();
  if (corePath) {
    try {
      core = await loadCore(corePath);
    } catch (err) {
      console.error(
        `${yellow('Core definition unreadable:')} ${corePath} — ${err.message}\n${dim('Drift against core.yaml cannot be checked.')}\n`,
      );
    }
  }

  // Loaded whether or not a core resolved: drift is the only consumer
  // that needs `core` composed against these, and graphStatus already
  // gates that on `core` itself. The orphan check reads task ids out of
  // the database, so it is answerable — and worth answering — on a
  // project whose core.yaml is missing or unparseable. A missing
  // overrides directory reads as an empty Map (loadOverrides), so this
  // costs nothing on a project that has never written one.
  //
  // A malformed override file throws, and for the same reason an
  // unparseable core.yaml doesn't take `status` down, neither may this:
  // status is the command every session starts with, and the report of
  // the broken file is more useful than an aborted overview.
  let overrides = new Map();
  try {
    overrides = await loadOverrides();
  } catch (err) {
    console.error(
      `${yellow('Override file unreadable:')} ${err.message}\n${dim('Scope overrides are ignored until it parses.')}\n`,
    );
  }

  const db = openDb();
  let result;
  try {
    result = graphStatus(db, { core, overrides });
  } finally {
    db.close();
  }

  // Declared-binary check (core.yaml's `requires:`) rides on `status`
  // because status is what a fresh session runs first — that's the point
  // at which "this core needs terraform" is a setup fact rather than an
  // opaque exit 127 twenty minutes into the build. Reuses the `core`
  // already loaded above for drift — a project with no core definition
  // yet, or one that failed to parse (reported above already), has
  // nothing to check and reports nothing here either.
  if (core) result.missingRequirements = coreMissingRequirements(core);

  console.log(formatStatus(result));

  // Whether the commit gate is actually enforcing. This is reported at
  // the start of every session because a gate that isn't running looks
  // exactly like one that is — `.git/hooks` exists, `lefthook.yml` is
  // committed, and a passing commit prints nothing to tell the two
  // apart. Nothing else in the discipline would notice.
  const gate = await commitGateStatus(DEST_ROOT);
  const gateText = formatCommitGate(gate);
  if (gateText) {
    console.log('');
    console.log(gate.state === 'active' ? dim(gateText) : yellow(gateText));
  }

  const warningLines = await coreWarningLines();
  if (warningLines.length > 0) console.log(warningLines.join('\n'));

  await noteAvailableUpdate();
}

// `hedgehog ready` — read-only preview of what a `hedgehog claim` call
// would claim right now, and why anything ready is held back. Claims
// nothing.
async function readyCommand() {
  await ensureDb();

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  let result;
  try {
    result = readyTasks(db);
  } finally {
    db.close();
  }

  console.log(formatReady(result));
}

// `hedgehog quiesce` — reports whether anything is still in flight
// (`building` or `verifying`), for a caller that has stopped dispatching
// and wants to know it's safe to treat the graph as settled. Claims and
// changes nothing; exits non-zero when the graph isn't quiesced yet so a
// caller can poll it in a loop or script.
async function quiesceCommand() {
  await ensureDb();

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  let inFlight;
  try {
    ({ inFlight } = graphStatus(db));
  } finally {
    db.close();
  }

  if (inFlight.length === 0) {
    console.log(`${green(bold('Quiesced.'))} Nothing in flight.`);
    return;
  }

  console.error(`${yellow(bold('Not quiesced.'))} ${inFlight.length} task(s) still in flight:\n`);
  for (const task of inFlight) {
    console.error(`  ${task.id}   ${task.status}    owner: ${task.lease_owner}`);
  }
  process.exitCode = 1;
}

// `hedgehog boundary [--quiet] [--handoff]` — is this a good moment to
// clear the conversation, and where would a fresh one pick up?
//
// `quiesce` answers one third of that question (nothing in flight).
// This answers all of it: nothing in flight, a clean working tree, and a
// last closed task that completed its intent — see boundary.mjs for how
// each is derived. Exits 0 only when all three hold, so a shell hook can
// consume it without reading anything.
//
// Output is split by consumer, not by importance:
//   stdout — the payload worth capturing: the NEXT/WHY positioning block,
//            or with --handoff the full block a fresh session starts from.
//   stderr — the verdict and the per-condition results, so a non-zero
//            exit always names which condition failed without that
//            commentary landing in a captured payload.
//   --quiet drops the commentary and the default payload, leaving the
//            exit code (and, if asked for explicitly, --handoff's block).
//
// Exit codes: 0 boundary reached; 1 not a boundary; 2 the question can't
// be answered here (no build graph, no git repository, or a last closed
// task that isn't identifiable).
async function boundaryCommand(args) {
  const quiet = args.includes('--quiet');
  const handoff = args.includes('--handoff');

  await ensureDb({ log: (msg) => console.error(msg) });

  if (!(await exists(DB_PATH))) {
    if (!quiet) {
      console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    }
    process.exitCode = 2;
    return;
  }

  const db = openDb();
  let state;
  try {
    state = boundaryState(db);
  } finally {
    db.close();
  }

  if (!quiet) console.error(formatBoundary(state));
  if (handoff) console.log(formatHandoff(state));
  else if (!quiet && state.reached) console.log(formatPosition(state));

  if (state.undecidable) {
    process.exitCode = 2;
    return;
  }
  if (!state.reached) {
    process.exitCode = 1;
  }
}

const GRAPH_PIDFILE_PATH = '.hedgehog/graph-server.json';
const GRAPH_SERVER_MODULE = join(PKG_ROOT, 'src/db/graph-server.mjs');
const GRAPH_TEMPLATE_PATH = join(PKG_ROOT, 'src/templates/graph.html');

// Opens a URL/file with the OS default handler — the same mechanism
// `open` (macOS), `xdg-open` (Linux), and `start` (Windows) provide,
// chosen per-platform so this stays a zero-dependency CLI rather than
// reaching for an npm package to do what the OS already does.
function openInBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  const args = platform === 'win32' ? ['', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform === 'win32' }).unref();
}

// True when there is plausibly a local display for a browser to open on.
// macOS and Windows always have one; on Linux/BSD a session with neither
// DISPLAY nor WAYLAND_DISPLAY set is headless (an SSH session, a
// container, an agent's non-interactive shell), and `xdg-open` there
// either fails silently or blocks on a text browser. Printing the URL is
// the useful behaviour in that case — a person on the other end of a
// port-forward can still open it.
//
// HEDGEHOG_FORCE_HEADLESS bypasses the platform check entirely — the
// repro suite's only way to exercise the no-display branch on macOS/
// Windows, where DISPLAY/WAYLAND_DISPLAY are never consulted for real
// users. Not a documented user-facing flag.
function hasDisplay() {
  if (process.env.HEDGEHOG_FORCE_HEADLESS) return false;
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// Hands `url` to the OS browser when that can work, and otherwise prints
// it. One place, so `plan --open` and `graph` behave identically.
function presentGraphUrl(url, { noOpen = false } = {}) {
  if (noOpen || !hasDisplay()) {
    console.log(`\nOpen ${bold(url)} in a browser to view it.`);
    return;
  }
  openInBrowser(url);
}

// True if `pid` names a live process. Sending signal 0 performs the
// existence/permission check without actually signalling anything — the
// standard POSIX idiom `kill -0` follows, and Node exposes it the same
// way via process.kill.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Returns the port of a running graph server for this project, starting
// one if none is live. Both `plan --open` and `graph` call this rather
// than each managing their own server, so a project only ever has one
// live server no matter which command a person or agent happens to run —
// re-running `plan --open` after `graph` is already open reuses the same
// tab's server instead of spawning a second one bound to a different
// port. Nothing else calls it: a command that isn't asked to open the
// graph starts no server, so it can leave neither a pidfile nor a
// detached process behind.
async function startOrReuseGraphServer() {
  const pidfilePath = join(DEST_ROOT, GRAPH_PIDFILE_PATH);

  if (await exists(pidfilePath)) {
    try {
      const { pid, port } = JSON.parse(await readFile(pidfilePath, 'utf8'));
      if (isProcessAlive(pid)) return { port, reused: true };
    } catch {
      // Corrupt or half-written pidfile from a killed server — fall
      // through and start a fresh one rather than failing the command.
    }
    await rm(pidfilePath, { force: true });
  }

  const child = spawn(
    process.execPath,
    [GRAPH_SERVER_MODULE, join(DEST_ROOT, DB_PATH), GRAPH_TEMPLATE_PATH, pidfilePath],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  child.unref();

  // Waits for graph-server.mjs's own "LISTENING <port>" line rather than
  // polling the pidfile, so the caller can't race a pidfile that exists
  // but was written a moment before the port was actually bound.
  //
  // child.unref() alone only unrefs the child process handle — the
  // stdout pipe is a separate stream the parent still holds open, and
  // leaving a 'data' listener on it keeps the event loop alive even
  // after this promise resolves (the earlier version of this function
  // hung the parent CLI process for exactly that reason). Explicitly
  // removing every listener and unref()-ing the stream once the port is
  // known lets the parent exit as soon as its own work is done, leaving
  // the detached child running independently.
  const port = await new Promise((resolvePort, rejectPort) => {
    let buf = '';
    function cleanup() {
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout.unref();
    }
    function onData(chunk) {
      buf += chunk;
      const match = buf.match(/LISTENING (\d+)/);
      if (match) {
        cleanup();
        resolvePort(Number(match[1]));
      }
    }
    function onError(err) {
      cleanup();
      rejectPort(err);
    }
    function onExit(code) {
      if (code !== 0) {
        cleanup();
        rejectPort(new Error(`graph server exited early (code ${code})`));
      }
    }
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  return { port, reused: false };
}

async function graphCommand(args) {
  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const { port, reused } = await startOrReuseGraphServer();
  const url = `http://localhost:${port}`;
  console.log(
    `  ${reused ? dim('reusing') : green('started')}  graph server ${dim(`(${url})`)}`,
  );

  // --no-open covers headless/SSH sessions where there's no local
  // browser to hand a URL to — the server itself is still started (or
  // reused) either way, since a remote person may open the URL manually
  // via port-forwarding. presentGraphUrl reaches the same outcome
  // unasked when the session has no display at all.
  presentGraphUrl(url, { noOpen: args.includes('--no-open') });
}

async function whyCommand(args) {
  await ensureDb();

  const path = args[0];
  if (!path) {
    console.error(`${red('Usage:')} hedgehog why <path>\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  let chain;
  try {
    chain = whyPath(db, path);
  } finally {
    db.close();
  }

  console.log(formatWhy(path, chain));
}

async function frictionCommand(args) {
  await ensureDb();

  const sub = args[0];

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'add') {
    // Split `--task <id>` out of the note words by index, not by value —
    // filtering on the *value* dropped the flag but kept its argument in
    // the note (and would mangle a note that legitimately contains the
    // word "--task").
    const rest = args.slice(1);
    const taskIdx = rest.indexOf('--task');
    const taskId = taskIdx !== -1 ? rest[taskIdx + 1] : undefined;
    if (taskIdx !== -1 && !taskId) {
      console.error(`${red('--task requires a task id')}\n`);
      process.exitCode = 1;
      return;
    }
    const note = rest
      .filter((_, i) => taskIdx === -1 || (i !== taskIdx && i !== taskIdx + 1))
      .join(' ');
    if (!note) {
      console.error(`${red('Usage:')} hedgehog friction add "<note>" [--task <task-id>]\n`);
      process.exitCode = 1;
      return;
    }

    printDbTarget();

    const db = openDb();
    let entry;
    try {
      entry = await addFriction(db, { note, taskId });
    } catch (err) {
      console.error(`${red('Failed to log friction:')} ${err.message}\n`);
      process.exitCode = 1;
      return;
    } finally {
      db.close();
    }

    console.log(`  ${green('logged')}  #${entry.id}${entry.taskId ? ` (${entry.taskId})` : ''}`);
    return;
  }

  if (sub === 'list') {
    const db = openDb();
    let entries;
    try {
      entries = listFriction(db);
    } finally {
      db.close();
    }

    if (entries.length === 0) {
      console.log(`${dim('No friction logged.')}\n`);
      return;
    }
    for (const entry of entries) {
      console.log(`#${entry.id}  ${dim(entry.loggedAt)}${entry.taskId ? `  ${bold(entry.taskId)}` : ''}`);
      console.log(`  ${entry.note}\n`);
    }
    return;
  }

  console.error(
    `${red('Unknown friction subcommand:')} ${sub ?? '(none)'}\n\nUsage: hedgehog friction add "<note>" [--task <task-id>]\n   or: hedgehog friction list\n`,
  );
  process.exitCode = 1;
}

// `hedgehog override add <task-id> --scope <glob> [--scope <glob>...]
// --reason "<why>"` / `hedgehog override list` — per-task scope
// exceptions (see src/db/overrides.mjs). Writes
// .hedgehog/overrides/<task-id>.json; the next `hedgehog plan` (for a
// not-yet-compiled task) or `hedgehog plan --recompile` (for one already
// compiled) is what actually widens the task's scope_globs — this command
// only records the committed intent to do so.
async function overrideCommand(args) {
  await ensureDb();

  const sub = args[0];

  if (sub === 'add') {
    const taskId = args[1];
    const rest = args.slice(2);
    const scopeAdd = [];
    let reason;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--scope') {
        if (!value) {
          console.error(`${red('--scope requires a glob')}\n`);
          process.exitCode = 1;
          return;
        }
        scopeAdd.push(value);
        i++;
      } else if (flag === '--reason') {
        if (!value) {
          console.error(`${red('--reason requires text')}\n`);
          process.exitCode = 1;
          return;
        }
        reason = value;
        i++;
      } else {
        console.error(`${red('Unknown override flag:')} ${flag}\n`);
        process.exitCode = 1;
        return;
      }
    }

    if (!taskId || scopeAdd.length === 0 || !reason) {
      console.error(
        `${red('Usage:')} hedgehog override add <task-id> --scope <glob> [--scope <glob>...] --reason "<why>"\n`,
      );
      process.exitCode = 1;
      return;
    }

    let record;
    try {
      record = await addOverride({ task: taskId, scope_add: scopeAdd, reason });
    } catch (err) {
      console.error(`${red('Failed to add override:')} ${err.message}\n`);
      process.exitCode = 1;
      return;
    }

    console.log(`  ${green('added')}  ${OVERRIDES_DIR}/${record.task.toLowerCase()}.json`);
    for (const glob of record.scope_add) console.log(`    + ${glob}`);
    console.log(
      `  ${dim(`run \`hedgehog plan --recompile\` to widen ${record.task} now, if it's already compiled`)}\n`,
    );
    return;
  }

  if (sub === 'list') {
    const overrides = await loadOverrides();
    if (overrides.size === 0) {
      console.log(`${dim('No overrides recorded.')}\n`);
      return;
    }

    // Best-effort: an override file can legitimately exist before `db
    // init`/`plan` has ever run (e.g. written ahead of the intent it
    // targets), so a missing DB just skips the orphan check rather than
    // failing the whole listing.
    let orphaned = [];
    if (await exists(DB_PATH)) {
      const db = openDb({ readOnly: true });
      try {
        orphaned = orphanedOverrides(db, overrides);
      } finally {
        db.close();
      }
    }

    for (const [taskId, records] of overrides) {
      for (const record of records) {
        console.log(`${bold(taskId)}`);
        console.log(`  ${dim(record.reason)}`);
        for (const glob of record.scope_add) console.log(`  + ${glob}`);
        console.log('');
      }
    }

    if (orphaned.length > 0) {
      console.log(
        `${yellow(bold('Orphaned:'))} ${orphaned.join(', ')} — no task with this id exists in the\n` +
          `build graph yet. A typo'd id, a renamed layer/module, or an intent that hasn't\n` +
          `compiled yet all look like this; it silently widens nothing until the id matches.\n`,
      );
    }
    return;
  }

  console.error(
    `${red('Unknown override subcommand:')} ${sub ?? '(none)'}\n\n` +
      `Usage: hedgehog override add <task-id> --scope <glob> [--scope <glob>...] --reason "<why>"\n` +
      `   or: hedgehog override list\n`,
  );
  process.exitCode = 1;
}

// `hedgehog debt add <task-id> "<note>"` / `hedgehog debt list [<task-id>]`
// — declared debt between tasks. A note recorded against a task is
// rendered into the INHERITED DEBT section of the packet of every task
// that depends on it (see src/db/debt.mjs and src/db/next.mjs).
async function debtCommand(args) {
  await ensureDb();

  const sub = args[0];

  if (!(await exists(DB_PATH))) {
    console.error(`${red('No build graph found.')} Run ${bold('hedgehog db init')} first.\n`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'add') {
    const taskId = args[1];
    const note = args.slice(2).join(' ');
    if (!taskId || !note) {
      console.error(`${red('Usage:')} hedgehog debt add <task-id> "<note>"\n`);
      process.exitCode = 1;
      return;
    }

    const db = openDb();
    let entry;
    try {
      entry = addDebt(db, { taskId, note });
    } catch (err) {
      console.error(`${red('Failed to declare debt:')} ${err.message}\n`);
      process.exitCode = 1;
      return;
    } finally {
      db.close();
    }

    console.log(`  ${green('declared')}  #${entry.id} ${bold(entry.taskId)}`);
    console.log(`  ${dim('reaches the packet of every task depending on it')}`);
    return;
  }

  if (sub === 'list') {
    const taskId = args[1];
    const db = openDb();
    let entries;
    try {
      entries = listDebt(db, taskId);
    } finally {
      db.close();
    }

    if (entries.length === 0) {
      console.log(`${dim('No debt declared.')}\n`);
      return;
    }
    for (const entry of entries) {
      console.log(`#${entry.id}  ${dim(entry.loggedAt)}  ${bold(entry.taskId)}`);
      console.log(`  ${entry.note}\n`);
    }
    return;
  }

  console.error(
    `${red('Unknown debt subcommand:')} ${sub ?? '(none)'}\n\nUsage: hedgehog debt add <task-id> "<note>"\n   or: hedgehog debt list [<task-id>]\n`,
  );
  process.exitCode = 1;
}

// `hedgehog cores list` — every core this release can install, the
// package that ships it, and which of its versions are already extracted
// locally. The prose each entry carries is what planner reads in Phase 0
// to decide which core a project is, so it prints here too rather than
// living only in the registry file.
async function coresCommand(args) {
  const sub = args[0] ?? 'list';
  if (sub !== 'list') {
    console.error(`${red('Unknown cores subcommand:')} ${sub}\n\nUsage: hedgehog cores list\n`);
    process.exitCode = 1;
    return;
  }

  const active = await installedCore(DEST_ROOT);
  for (const core of await loadRegistry()) {
    const cached = await cachedVersions(core.name);
    const marker = active?.name === core.name ? green(' (installed)') : '';
    console.log(`${bold(core.name)}${marker}`);
    console.log(`  ${dim('package')}  ${core.package}@${core.version}`);
    console.log(`  ${dim('flag')}     ${core.flag ?? dim('none — chosen at planning intake')}`);
    console.log(`  ${dim('cached')}   ${cached.length ? cached.join(', ') : dim('not fetched')}`);
    console.log(`  ${dim('when')}     ${wrapProse(core.selects_when, 68, '           ')}`);
    console.log('');
  }
}

// Wraps prose to `width`, indenting every line after the first so it sits
// under the column its label opened.
function wrapProse(text, width, indent) {
  const lines = [];
  let line = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    await help();
    return;
  }
  const cmd = args[0];
  const force = args.includes('--force') || args.includes('-f');

  // Which core to install now, named either by `--core <name>` /
  // `--core=<name>` or by that core's own shorthand flag — the two are
  // equivalent, and both resolve through the registry. Absent either, the
  // core is left for planner to choose at planning intake.
  const requestedCore = await namedCore(args);
  let coreEntry = null;
  if (requestedCore !== null) {
    coreEntry = await resolveCore(requestedCore);
    if (!coreEntry) {
      console.error(
        `${red('Unknown core:')} ${requestedCore}\n\nAvailable cores: ${(await availableCores()).join(', ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Which coding agent this repo is being set up for. `--host=<name>` and
  // the per-host shorthand flags are equivalent; absent either, the
  // default host applies.
  const allHosts = args.includes('--all-hosts');
  const hostFlags = args.filter((a) => a in HOST_FLAGS).map((a) => HOST_FLAGS[a]);
  const hostEq = args
    .filter((a) => a.startsWith('--host='))
    .flatMap((a) => a.slice('--host='.length).split(','))
    .map((h) => h.trim())
    .filter(Boolean);
  const named = [...new Set([...hostFlags, ...hostEq])];
  const unknown = named.filter((h) => !(h in HOSTS));
  if (unknown.length) {
    console.error(
      `${red('Unknown host:')} ${unknown.join(', ')}\n\n` +
        `Available hosts: ${availableHosts().join(', ')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const hosts = allHosts ? availableHosts() : named;

  if (cmd === 'init') {
    // Fetched once, before any host is written: every host installs from
    // the same extraction, and a core that cannot be resolved has to stop
    // the install before it writes a partial payload.
    // A host added to a project that already has a core installs that
    // core's agents and skills too, so every host carries the same
    // payload whether or not the core is named again.
    let entry = coreEntry;
    if (!entry) {
      const record = await installedCore(DEST_ROOT);
      if (record) entry = await resolveCore(record.name);
    }

    let core = null;
    if (entry) {
      try {
        core = await fetchCore(entry);
      } catch (err) {
        console.error(`\n${red(bold('Core unavailable.'))} ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
    }

    // The shared payload — vendored shelves, core workspace — lands with
    // the first host; the rest add only what differs per host.
    const targets = hosts.length ? hosts : [DEFAULT_HOST];
    for (const [i, host] of targets.entries()) {
      await init({ force, core, host, hostOnly: i > 0 });
    }
    return;
  }

  if (cmd === 'cores') {
    await coresCommand(args.slice(1));
    return;
  }

  if (cmd === 'update') {
    if (args.includes('--check')) {
      await updateCheck();
      return;
    }
    await update({ hosts });
    return;
  }

  if (cmd === 'db') {
    await dbCommand(args.slice(1));
    return;
  }

  if (cmd === 'plan') {
    await planCommand(args.slice(1));
    return;
  }

  if (cmd === 'intent') {
    await intentCommand(args.slice(1));
    return;
  }

  if (cmd === 'next') {
    await nextCommand();
    return;
  }

  if (cmd === 'verify') {
    await verifyCommand(args.slice(1));
    return;
  }

  if (cmd === 'claim') {
    await claimCommand(args.slice(1));
    return;
  }

  if (cmd === 'show') {
    await showCommand(args.slice(1));
    return;
  }

  if (cmd === 'retry') {
    await retryCommand(args.slice(1));
    return;
  }

  if (cmd === 'release') {
    await releaseCommand(args.slice(1));
    return;
  }

  if (cmd === 'renew') {
    await renewCommand(args.slice(1));
    return;
  }

  if (cmd === 'status') {
    await statusCommand();
    return;
  }

  if (cmd === 'ready') {
    await readyCommand();
    return;
  }

  if (cmd === 'quiesce') {
    await quiesceCommand();
    return;
  }

  if (cmd === 'boundary') {
    await boundaryCommand(args.slice(1));
    return;
  }

  if (cmd === 'graph') {
    await graphCommand(args.slice(1));
    return;
  }

  if (cmd === 'why') {
    await whyCommand(args.slice(1));
    return;
  }

  if (cmd === 'friction') {
    await frictionCommand(args.slice(1));
    return;
  }

  if (cmd === 'debt') {
    await debtCommand(args.slice(1));
    return;
  }

  if (cmd === 'override') {
    await overrideCommand(args.slice(1));
    return;
  }

  console.error(`${red('Unknown command:')} ${cmd}\n`);
  await help();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n${red(bold('Install failed:'))} ${err.message}\n`);
  process.exitCode = 1;
});
