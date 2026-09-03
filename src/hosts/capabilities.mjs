// Which tools each agent role needs, named as a host-neutral capability.
//
// Each host spells its tool grant in its own vocabulary, so the grant is
// stated once here and mapped per host below. This file owns the
// agent -> capability fact; `src/agents/*.md` carries the Claude Code
// spelling of it in its `tools:` frontmatter, which Claude Code reads
// directly.

/** @typedef {'full'|'no-bash'|'readonly-bash'|'readonly'|'write-only'} Capability */

/** @type {Record<string, Capability>} */
export const AGENT_CAPABILITY = {
  // Build and scaffold: read, write, and run commands.
  'backend-eng': 'full',
  bootstrap: 'full',
  'copy-writer': 'full',
  'front-end-eng': 'full',
  'harness-eng': 'full',
  'landing-builder': 'full',
  'landing-copywriter': 'full',
  'landing-executor': 'full',
  'layer-eng': 'full',
  planner: 'full',
  'pwa-eng': 'full',
  tweaker: 'full',

  // Inspect and report; the verification command (and, for the Polish
  // Loop reviewers, the build/screenshot/interaction commands) is theirs
  // to run.
  reviewer: 'readonly-bash',
  'landing-visual-reviewer': 'readonly-bash',
  'landing-ux-reviewer': 'readonly-bash',

  // Write its rationale artifact, nothing else.
  'ux-planner': 'write-only',
};

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
  'no-bash': {
    read: true,
    write: true,
    run: false,
    summary: 'Read, write, and edit files. Do not run shell commands.',
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

// The capability for one agent, by `name` frontmatter. Unknown agents get
// the most restrictive grant rather than the most permissive one, so a new
// agent added without a table entry fails closed.
export function capabilityFor(agentName) {
  return AGENT_CAPABILITY[agentName] ?? 'readonly';
}

export function grantFor(agentName) {
  return CAPABILITY_GRANT[capabilityFor(agentName)];
}
