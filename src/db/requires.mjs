// Declared binary requirements for a layer's verify command.
//
// A layer's `verify` runs through the shell with whatever environment
// the caller happened to have (src/db/verify.mjs#runVerifyCommand). That
// environment is not the one a person sees in their terminal: a login
// shell sources the profile that puts ~/.local/bin (and nvm, pyenv,
// asdf, homebrew…) on PATH, and an agent's non-interactive shell does
// not. The same core then verifies green by hand and fails with a bare
// `exit 127` under the agent — the mode Hedgehog is actually built for.
//
// `requires: [terraform, tofu]` in core.yaml, alongside scope/verify/
// commit, is the layer saying which binaries its verify command needs.
// Two things consume it:
//
//   * `hedgehog status` — reports every missing binary before a build
//     starts, so a missing tool is a setup fact rather than a mid-build
//     surprise;
//   * `hedgehog verify` — refuses to run a verify command whose declared
//     binaries aren't resolvable, naming the binary and the layer
//     instead of letting the shell produce a 127 with no context.
//
// Resolution is a plain PATH walk rather than shelling out to
// `which`/`where`: it must answer "would the shell that runs the verify
// command find this?", and that shell inherits exactly this process's
// PATH. Spawning a subprocess to ask would add a dependency on yet
// another binary being present.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Windows has no execute bit; a name is runnable when it exists with one
// of PATHEXT's extensions (or already carries one).
function windowsCandidates(name, env) {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const hasExt = exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  return hasExt ? [name] : [name, ...exts.map((ext) => `${name}${ext}`)];
}

// Resolves `name` the way the verify command's shell would, and returns
// the absolute path or null. A name containing a path separator (or an
// absolute path) is checked as given rather than searched for, matching
// shell behaviour.
export function findBinary(name, env = process.env) {
  const platform = process.platform;
  const candidates = platform === 'win32' ? windowsCandidates(name, env) : [name];

  if (isAbsolute(name) || name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

// The subset of `names` that isn't resolvable, order preserved.
export function missingBinaries(names, env = process.env) {
  return (names ?? []).filter((name) => findBinary(name, env) === null);
}

// Every (layer, binary) pair a core declares and this environment can't
// satisfy. Layers with no `requires` contribute nothing — the field is
// optional and every core predating it is unaffected.
export function coreMissingRequirements(core, env = process.env) {
  const missing = [];
  for (const layer of core.layers ?? []) {
    for (const binary of missingBinaries(layer.requires, env)) {
      missing.push({ layer: layer.id, binary });
    }
  }
  return missing;
}

// Renders coreMissingRequirements()'s result for `hedgehog status`.
// Returns [] when nothing is missing, so the caller can splice it into
// the report without a conditional of its own.
export function formatMissingRequirements(missing) {
  if (!missing || missing.length === 0) return [];
  const lines = ['MISSING BINARIES'];
  for (const { layer, binary } of missing) {
    lines.push(`  ${binary}   required by layer "${layer}" (declared in core.yaml requires:)`);
  }
  lines.push('');
  lines.push('  These layers will fail verification until each binary is on PATH');
  lines.push('  for the shell that runs hedgehog (not just your interactive shell).');
  return lines;
}
