// Rewrites a canonical agent file for a host that carries the role in a
// prompt rather than registering it with its own tool grant.
//
// `model:`, `color:`, and `tools:` are Claude Code's subagent schema.
// Elsewhere the role travels as text, so those keys come off and the tool
// grant is restated as a line the agent reads — the same fact in the form
// that host can act on. `hedgehog verify` gates the commit on ALLOWED
// SCOPE regardless.

import { parse, stringify } from './frontmatter.mjs';
import { grantFor } from './capabilities.mjs';

const CLAUDE_ONLY = ['model', 'color', 'tools'];

export function emitPromptAgent(text) {
  const { data, body } = parse(text);
  const kept = { ...data };
  for (const key of CLAUDE_ONLY) delete kept[key];

  const grant = grantFor(data.name);
  const constraint = `**Tools for this role:** ${grant.summary}\n\n`;
  return stringify(kept, `\n${constraint}${body.replace(/^\n+/, '')}`);
}

// OpenCode registers subagents from `.opencode/agents/` markdown files.
// Its frontmatter wants `description` and `mode`, and the file name is
// the agent name. Claude Code's `model:`/`tools:` subagent schema and
// the redundant `name:` come off; the tool grant is restated as a line
// the agent reads — `hedgehog verify` gates the commit regardless.
export function emitOpencodeAgent(text) {
  const { data, body } = parse(text);
  const kept = { ...data };
  for (const key of [...CLAUDE_ONLY, 'name']) delete kept[key];
  kept.mode = 'subagent';

  const grant = grantFor(data.name);
  const constraint = `**Tools for this role:** ${grant.summary}\n\n`;
  return stringify(kept, `\n${constraint}${body.replace(/^\n+/, '')}`);
}
