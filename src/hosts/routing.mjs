// Generates AGENTS.md — the routing doc for coding agents that read a
// root instructions file but don't register Hedgehog's agents themselves.
//
// It is an *index*: every row points at the file that owns the
// substance. The tables are built from each agent's and skill's own
// `description` frontmatter, so a new agent or a reworded description
// shows up here without this file being edited.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './frontmatter.mjs';
import { capabilityFor, CAPABILITY_GRANT } from './capabilities.mjs';

// A description is a full paragraph aimed at a dispatcher deciding
// whether to invoke this role. The table wants the trigger, so take the
// first sentence and let the file itself carry the rest.
function firstSentence(text = '') {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/\.\s|\.$/);
  const out = end === -1 ? flat : flat.slice(0, end + 1);
  return out.replaceAll('|', '\\|');
}

async function readEntries(dir, filename) {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => (filename ? e.isDirectory() : e.isFile() && e.name.endsWith('.md')))
    .map((e) => e.name)
    .sort();

  const out = [];
  for (const name of names) {
    const path = filename ? join(dir, name, filename) : join(dir, name);
    const { data } = parse(await readFile(path, 'utf8'));
    if (!data.name) continue;
    out.push({ ...data, file: filename ? `${name}/${filename}` : name });
  }
  return out;
}

export async function renderAgentsMd({ pkgRoot, hosts }) {
  const agents = await readEntries(join(pkgRoot, 'src/agents'));
  const skills = await readEntries(join(pkgRoot, 'src/skills'), 'SKILL.md');

  // One project can be set up for several coding agents at once. Paths
  // are quoted per host so whichever one is reading finds its own copy.
  const dirs = (pick) =>
    [...new Set(hosts.map(pick))].map((d) => `\`${d}\``).join(' or ');

  const agentRows = agents
    .map((a) => {
      const grant = CAPABILITY_GRANT[capabilityFor(a.name)];
      return `| \`${a.name}\` | ${firstSentence(a.description)} | ${grant.summary} | \`${a.file}\` |`;
    })
    .join('\n');

  const skillRows = skills
    .map((s) => `| \`${s.name}\` | ${firstSentence(s.description)} | \`${s.file}\` |`)
    .join('\n');

  return `# Working in this repo

This project is built with **Hedgehog**, a one-step-at-a-time build
discipline. The rules below aren't preferences — they're how the build
stays mechanically correct.

**State lives in the build graph (\`.hedgehog/hedgehog.db\`), the commit
log, and the code.** A fresh session loses nothing: run \`hedgehog status\`
and read the commit log to recover.

## Start here

\`\`\`bash
hedgehog status    # what's built, what's ready, what's blocked
hedgehog next      # the task packet for one ready step
\`\`\`

Agent files live in ${dirs((h) => h.agentsDir)}, and skills in
${dirs((h) => h.skillsDir)}. The tables below name each file relative to
those directories.

If this project's instructions file still has unfilled \`{{PLACEHOLDER}}\`
text, nothing has been built yet — read \`planner.md\` and run planning
intake first.

## The loop

1. \`hedgehog next\` emits one task packet — STATUS, INTENT (the goal and
   outcome of the whole intent, not just this layer), RELEVANT RULES,
   INHERITED DEBT, WHY NOW, BLOCKED DOWNSTREAM, ALLOWED SCOPE,
   VERIFICATION. \`hedgehog claim\` emits the same packet and reserves the
   task with a lease. Trust it: a task is never
   emitted unless every dependency is \`complete\`.
2. Delegate the **full packet** to the agent that owns that layer (see
   the table below). Don't summarize it, and don't pass just a step name.
3. When the work is done, run \`hedgehog verify <task-id>\`. It checks the
   touched files against ALLOWED SCOPE, runs the verification command,
   and on a pass writes the commit and unlocks what the task blocked.

**An agent reporting success never moves a task — only a passing
\`hedgehog verify\` does.** This is the enforcement, and it holds no
matter which coding agent you are or what tools you were granted.

## Delegating

If your harness dispatches subagents, read the agent's file and pass its
**entire body** as that subagent's prompt, followed by the task packet.
The file is the role — don't summarize it.

If your harness has no subagent mechanism, read the agent's file and
follow it yourself in this thread, then clear the conversation at the
next unit boundary (a module's Phase A, a landing page section) and
recover with \`hedgehog status\`.

Either way, honor the "May" column below. Where a harness can't enforce a
tool grant, the constraint is yours to keep — and \`hedgehog verify\` still
gates the commit on ALLOWED SCOPE.

## Agents

| Agent | Use when | May | File |
| --- | --- | --- | --- |
${agentRows}

## Skills

Procedures to follow, not to improvise around. Read the file when its
situation applies.

| Skill | Use when | File |
| --- | --- | --- |
${skillRows}

## CLI reference

| Command | Does |
| --- | --- |
| \`hedgehog status\` | Every task, its state, and what it blocks |
| \`hedgehog next\` | The task packet for one ready task |
| \`hedgehog verify <task-id>\` | Gate a task: scope check, verification command, commit |
| \`hedgehog why <path>\` | Which task and layer a file belongs to |
| \`hedgehog plan\` | Compile intents into the task graph |
| \`hedgehog intent add\` | Record an intent at planning intake |
| \`hedgehog friction add "<note>"\` | Log build friction for later review |
| \`hedgehog friction list\` | Read the friction log |
| \`hedgehog graph\` | Live read-only diagram of the build graph |
`;
}
