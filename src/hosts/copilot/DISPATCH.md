## Delegating on this host

GitHub Copilot loads instructions from `.github/copilot-instructions.md` and
indexes the discipline in `AGENTS.md`.

Agent definitions live in `.github/agents/`. Where custom agents or subagents
are supported, invoke the agent by name and pass the `hedgehog next` packet
in full. In standard chat or inline sessions, read the agent's file and follow
its role for that task.

Independent steps can go out concurrently. Steps that depend on each other
stay sequential.

Each agent file carries its tool grant as a line of its prompt, and
`hedgehog verify` checks the touched files against the packet's ALLOWED
SCOPE before any commit lands.

The skills in `.github/skills/` are procedures to follow — read the one
whose situation applies rather than improvising the steps.

Clear context at the unit boundaries the `hedgehog-orchestrating` skill
states.