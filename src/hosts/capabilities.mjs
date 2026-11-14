// Which tools each agent role needs, named as a host-neutral capability.
//
// Each host spells its tool grant in its own vocabulary. The grant is
// stated once, in each agent file's `tools:` frontmatter (Claude Code's
// spelling, which Claude Code reads directly), and derived from there
// into a capability that every other host maps below. An agent a core
// package ships gets its capability the same way as one the engine ships.

/** @typedef {'full'|'readonly-bash'|'readonly'|'write-only'} Capability */

// What each capability permits, in host-neutral terms. Hosts that can't
// enforce a per-agent grant state these as constraints in the agent's
// prompt instead — `hedgehog verify` is what actually gates the commit,
// by checking touched files against the packet's ALLOWED SCOPE.
/** @type {Record<Capability, { read: boolean, write: boolean, run: boolean, summary: string }>} */
export const CAPABILITY_GRANT = {
  full: {
    read: true,
    write: true,
    run: true,
    summary: 'Read, write, and edit files, and run shell commands.',
  },
  'readonly-bash': {
    read: true,
    write: false,
    run: true,
    summary:
      'Read files and run shell commands. Do not write or edit any file — report findings as text.',
  },
  readonly: {
    read: true,
    write: false,
    run: false,
    summary:
      'Read files only. Do not write or edit any file, and do not run shell commands — report findings as text.',
  },
  'write-only': {
    read: true,
    write: true,
    run: false,
    summary:
      'Read files, and write only this role\'s own artifact. Do not run shell commands.',
  },
};

/**
 * The tool names in a `tools:` frontmatter value — a comma-separated
 * list, optionally bracketed. Empty when the field is absent or blank.
 * @param {string | undefined} tools
 * @returns {string[]}
 */
export function parseTools(tools) {
  if (typeof tools !== 'string') return [];
  return tools
    .replace(/^\s*\[|\]\s*$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * The capability a `tools:` grant amounts to. An absent or empty field
 * gets the most restrictive grant, so an agent that states no tools
 * fails closed.
 * @param {string | undefined} tools
 * @returns {Capability}
 */
export function capabilityFromTools(tools) {
  const names = new Set(parseTools(tools));
  const run = names.has('Bash');
  if (names.has('Edit') && names.has('Write') && run) return 'full';
  if (names.has('Write') && !run) return 'write-only';
  if (run && !names.has('Edit') && !names.has('Write')) return 'readonly-bash';
  return 'readonly';
}

/** The grant for one agent, from its parsed frontmatter. */
export function grantFor(frontmatter) {
  return CAPABILITY_GRANT[capabilityFromTools(frontmatter?.tools)];
}
