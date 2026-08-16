## Delegating on this host

The agent files in `.cursor/agents/` are the roles this build uses. To run
one, read its file and follow it for that task, passing the `hedgehog
next` packet in full. Where a subagent is available, pass the file's
entire body as that subagent's prompt — the file is the role.

Independent steps can go out as several concurrent tool calls in one
response. Steps that depend on each other stay sequential.

Each agent file opens with the tools that role may use. Honor it: Cursor
grants tools per session, so the constraint is yours to keep. `hedgehog
verify` checks the touched files against the packet's ALLOWED SCOPE and
gates the commit either way.

The skills in `.cursor/skills/` are procedures to follow — read the one
whose situation applies rather than improvising the steps.

Clear the conversation at the unit boundaries described above —
`hedgehog boundary` tells you whether you're at one (exit 0), and
`hedgehog boundary --handoff` is what the next session starts from.
