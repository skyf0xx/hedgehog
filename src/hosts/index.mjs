// The host registry: one entry per coding agent Hedgehog installs into.
//
// A host describes where the discipline's payload lands in a consuming
// repo and, where the host's format differs from the canonical one, how
// to emit it. `src/agents/` and `src/skills/` are the single source of
// truth for content — a host adapts packaging, never substance.
//
// Adding a host means adding one entry here (and a matching directory
// under src/hosts/<name>/ for whatever templates it needs).

import { emitPromptAgent, emitOpencodeAgent } from './emit.mjs';

// Hosts that dispatch real subagents get the full discipline: each build
// step runs in its own context with its own role. Hosts that don't are
// still supported through the AGENTS.md routing doc, which indexes the
// same agent and skill files for an agent to read inline. Either way
// `hedgehog verify` is what gates a commit, so correctness does not
// depend on the host's tool grants.

/**
 * @typedef {object} Host
 * @property {string} agentsDir      where agent definitions land
 * @property {string} skillsDir      where skill directories land
 * @property {string} bootstrapFile  the project file this host auto-loads
 * @property {(body: string, meta: object) => string} [emitAgent]
 *   rewrites one agent file for this host. Omitted when the canonical
 *   file is already in the host's format — the installer then copies it
 *   verbatim, which is what keeps Claude Code output byte-identical.
 * @property {Array<object>} [extraEntries] extra payload entries for this host
 */

// AGENTS.md is the convention a growing number of coding agents read
// from a repo root. Every host ships it: it costs one generated file and
// it means a second agent opening the project finds the discipline
// without a second install.
const routingDoc = (host) => ({
  type: 'generated',
  to: 'AGENTS.md',
  // Indexes every host the project is set up for, not just the one being
  // installed, so adding a second host doesn't strand the first one's
  // paths.
  generate: async ({ pkgRoot, projectRoot }) => {
    const [{ renderAgentsMd }, { installedHosts }] = await Promise.all([
      import('./routing.mjs'),
      import('./installed.mjs'),
    ]);
    const recorded = projectRoot ? await installedHosts(projectRoot) : [];
    const names = [...new Set([host, ...recorded])];
    return renderAgentsMd({ pkgRoot, hosts: names.map((n) => HOSTS[n]) });
  },
});

/** @type {Record<string, Host>} */
export const HOSTS = {
  // Claude Code reads src/agents/*.md and src/skills/ * /SKILL.md as
  // authored — frontmatter and all — so it has no emitter. This is the
  // canonical format every other host is adapted from.
  claude: {
    agentsDir: '.claude/agents',
    skillsDir: '.claude/skills',
    bootstrapFile: 'CLAUDE.md',
    label: 'Claude Code',
    get extraEntries() {
      return [routingDoc('claude')];
    },
  },

  // Cursor loads `.cursor/rules/*.mdc` on every request and reads
  // AGENTS.md at the repo root. The rule points at both, the project's
  // own context lives in HEDGEHOG.md, and the agent files carry their
  // tool grant as a line of the prompt.
  cursor: {
    agentsDir: '.cursor/agents',
    skillsDir: '.cursor/skills',
    bootstrapFile: 'HEDGEHOG.md',
    label: 'Cursor',
    emitAgent: emitPromptAgent,
    get extraEntries() {
      return [
        routingDoc('cursor'),
        {
          type: 'file',
          from: 'src/hosts/cursor/hedgehog.mdc',
          to: '.cursor/rules/hedgehog.mdc',
        },
      ];
    },
  },

  // Gemini CLI loads GEMINI.md at session start and resolves its `@./`
  // includes, so the routing doc comes in with it. `invoke_agent`
  // dispatches an untyped generalist, so each agent file carries its
  // tool grant as a line of the prompt it will be passed as.
  gemini: {
    agentsDir: '.gemini/agents',
    skillsDir: '.gemini/skills',
    bootstrapFile: 'GEMINI.md',
    label: 'Gemini CLI',
    emitAgent: emitPromptAgent,
    get extraEntries() {
      return [
        routingDoc('gemini'),
        {
          type: 'file',
          from: 'src/hosts/gemini/gemini-extension.json',
          to: 'gemini-extension.json',
        },
      ];
    },
  },

  // OpenCode auto-loads AGENTS.md from the repo root — the same file
  // every host ships as an index. The bootstrap merge carries the
  // discipline shell and the dispatch into it directly, so no separate
  // routing doc is generated and the file has one writer per install
  // flag. Subagents register from `.opencode/agents/` (the file name is
  // the agent name; Claude Code's `model:`/`tools:` subagent schema
  // comes off on install), and skills load on demand from
  // `.opencode/skills/`.
  opencode: {
    agentsDir: '.opencode/agents',
    skillsDir: '.opencode/skills',
    bootstrapFile: 'AGENTS.md',
    label: 'OpenCode',
    emitAgent: emitOpencodeAgent,
  },

  // Windsurf (Devin Desktop) auto-loads AGENTS.md from the repo root as
  // an always-on instruction file. The bootstrap merge carries the
  // discipline shell and dispatch into it directly. Subagents register
  // from `.devin/agents/` with their tool grant in the prompt, and
  // skills load from `.devin/skills/`.
  windsurf: {
    agentsDir: '.devin/agents',
    skillsDir: '.devin/skills',
    bootstrapFile: 'AGENTS.md',
    label: 'Windsurf',
    emitAgent: emitPromptAgent,
  },

  // GitHub Copilot loads `.github/copilot-instructions.md` as its
  // repo-wide instructions, so the discipline shell and dispatch land
  // there, and the generated AGENTS.md indexes the roles. Custom agents
  // register from `.github/agents/` (the file name is the agent name)
  // with their tool grant in the prompt, and skills load from
  // `.github/skills/`.
  copilot: {
    agentsDir: '.github/agents',
    skillsDir: '.github/skills',
    bootstrapFile: '.github/copilot-instructions.md',
    label: 'GitHub Copilot',
    emitAgent: emitPromptAgent,
    get extraEntries() {
      return [routingDoc('copilot')];
    },
  },
};

// One install flag per host, named for the tool a user is asking to use.
// Mirrors CORE_FLAGS in bin/cli.mjs: the public flag and the internal
// name are allowed to diverge so the CLI surface can stay stable.
export const HOST_FLAGS = {
  '--claude': 'claude',
  '--cursor': 'cursor',
  '--gemini': 'gemini',
  '--opencode': 'opencode',
  '--windsurf': 'windsurf',
  '--copilot': 'copilot',
};

export const DEFAULT_HOST = 'claude';

export const availableHosts = () => Object.keys(HOSTS).sort();
