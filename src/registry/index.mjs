// Core package registry. One entry per Hedgehog core — full-stack-app,
// pwa-app, landing-page, authored — naming the npm package that ships its
// agents, skills, and (for the three shipped cores) scaffold, plus the CLI
// flag `hedgehog init` accepts for it and the prose `planner` reads aloud
// in Phase 0 to choose one. A fixed table, one entry per core, discovered
// by name or flag rather than convention.
//
// `authored` carries no flag — it is never selected off a fixed list at
// install time. hedgehog-core-design chooses it during planning, from the
// drivers hedgehog-planning-intake's Phase 0 elicits, not from a value a
// user passes to `init`.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, 'cores.json');

let cached = null;

// Parses src/registry/cores.json into its `cores` array. Cached after the
// first read — the registry is static payload, not project state, so
// re-reading it per call would only cost time for no fresher an answer.
export async function loadRegistry() {
  if (cached) return cached;
  const text = await readFile(REGISTRY_PATH, 'utf8');
  const { cores } = JSON.parse(text);
  cached = cores;
  return cached;
}

// Resolves a core entry by its name (`full-stack-app`) or its CLI flag
// (`--ts-full-stack-app`), whichever nameOrFlag matches. Returns null when
// nothing matches — a lookup miss, not a malformed-input error (the same
// signal src/hosts/version.mjs uses for "no newer version found").
export async function resolveCore(nameOrFlag) {
  const cores = await loadRegistry();
  return cores.find((core) => core.name === nameOrFlag || core.flag === nameOrFlag) ?? null;
}
