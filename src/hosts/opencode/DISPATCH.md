## Delegating on this host

OpenCode registers subagents from `.opencode/agents/` — each file becomes
an agent named for the file. Invoke one with `@<name>` and pass it the
`hedgehog next` packet as the task: the full packet, not a step name.

Independent steps can go out as several subagent calls in one message.
Steps that depend on each other stay sequential.

Each agent file carries its tool grant as a line of its prompt, and
`hedgehog verify` checks the touched files against the packet's ALLOWED
SCOPE before any commit lands.

The skills in `.opencode/skills/` are procedures to follow — read the one
whose situation applies rather than improvising the steps.

Clear the conversation at the unit boundaries the `hedgehog-orchestrating`
skill states.
