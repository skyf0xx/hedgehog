// Is the commit gate actually enforcing? — the second line of defence
// behind `lefthook.yml`'s own `assert_lefthook_installed`.
//
// The gate's whole promise is that it can't be worked around, and its
// worst failure mode is not a broken hook but an absent one: `.git/hooks`
// is present, `lefthook.yml` is committed, and nothing in a commit's
// output distinguishes "passed the gate" from "there was no gate". Every
// signal a person would look at says gated. So the check has to be
// explicit, and it belongs somewhere read at the start of every session
// — which is `hedgehog status`.
//
// Read-only and never throws: a status command that fails because it
// couldn't stat a hook would be worse than the thing it reports on.

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

// The string `lefthook install` writes into the generated hook when
// `assert_lefthook_installed: true` is set. Its presence is the only
// way to tell a fail-closed hook from a fail-open one, since both are
// otherwise the same generated script — and the distinction matters,
// because the flag is baked in at install time, so a hook generated
// before the flag was set keeps failing open until it's regenerated.
const ASSERT_MARKER = 'Operation is aborted due to lefthook settings';

// Resolves the repo's hooks directory the way git itself does, so a
// project that has moved it with `core.hooksPath`, or is running from a
// worktree, isn't reported as ungated on the strength of an empty
// `.git/hooks`. Falls back to the conventional location if git can't be
// run at all — guessing the usual path is a better failure than
// announcing "no gate installed" because we couldn't spawn a process.
function hooksDir(projectRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return isAbsolute(out) ? out : join(projectRoot, out);
  } catch {
    // fall through
  }
  return join(projectRoot, '.git/hooks');
}

// The subset of the generated hook's own lookup chain that can be
// checked without running anything: the binary on PATH, and the two
// node_modules layouts lefthook's npm package produces. Deliberately
// not exhaustive — the hook also tries bundler/go/mise/etc. paths — so
// this only ever reports "missing" for the JS-toolchain install this
// core actually uses.
async function lefthookBinaryPresent(projectRoot) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await exists(join(dir, 'lefthook'))) return true;
  }
  if (await exists(join(projectRoot, 'node_modules/lefthook/bin/index.js'))) return true;

  const osArch = process.platform === 'win32' ? 'windows' : process.platform;
  const cpuArch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (await exists(join(projectRoot, `node_modules/lefthook-${osArch}-${cpuArch}/bin/lefthook`))) {
    return true;
  }
  return false;
}

// Returns { applicable, state, detail, repair }.
//
//   applicable false  this core doesn't gate commits with lefthook —
//                     nothing to report, and reporting "no gate" would
//                     be wrong rather than merely noisy
//   active            hooks installed, fail-closed, binary resolvable
//   not-installed     lefthook.yml is committed but no hook was written
//   fails-open        hook predates assert_lefthook_installed
//   binary-missing    hook would refuse, but the tooling is gone
export async function commitGateStatus(projectRoot) {
  if (!(await exists(join(projectRoot, 'lefthook.yml')))) {
    return { applicable: false };
  }

  const hook = join(hooksDir(projectRoot), 'pre-commit');

  if (!(await exists(hook))) {
    return {
      applicable: true,
      state: 'not-installed',
      detail: 'lefthook.yml is committed, but no pre-commit hook is installed.',
      repair: 'pnpm dlx lefthook install',
    };
  }

  let script;
  try {
    script = await readFile(hook, 'utf8');
  } catch {
    // Unreadable is not the same as absent, and guessing which one it
    // is would be worse than saying so.
    return {
      applicable: true,
      state: 'unknown',
      detail: `Could not read ${hook}.`,
      repair: 'pnpm dlx lefthook install',
    };
  }

  if (!script.includes(ASSERT_MARKER)) {
    return {
      applicable: true,
      state: 'fails-open',
      detail:
        'The installed hook predates assert_lefthook_installed — it exits 0 ' +
        'when lefthook is missing, so commits land ungated.',
      repair: 'pnpm dlx lefthook install   (regenerates the hook fail-closed)',
    };
  }

  if (!(await lefthookBinaryPresent(projectRoot))) {
    return {
      applicable: true,
      state: 'binary-missing',
      detail:
        'The hook is fail-closed, so it will refuse commits until lefthook ' +
        'is back — nothing is landing ungated, but nothing can land at all.',
      repair: 'pnpm install',
    };
  }

  return { applicable: true, state: 'active' };
}

// Plain text, colouring left to the caller — same split as formatStatus.
// Returns null when there's nothing worth printing.
export function formatCommitGate(gate) {
  if (!gate || !gate.applicable) return null;
  if (gate.state === 'active') return 'COMMIT GATE  active';

  const lines = ['COMMIT GATE  NOT ENFORCING', '', `  ${gate.detail}`, ''];
  lines.push(`  Restore it with: ${gate.repair}`);
  lines.push('  To commit anyway, deliberately: git commit --no-verify');
  return lines.join('\n');
}
