## Delegating on this host

Windsurf's Devin Local agent registers subagents from `.devin/agents/` —
each file becomes a profile named for the file. Ask for that profile by
name and pass it the `hedgehog next` packet as the task: the full packet,
not a step name.

Subagents need **Subagents (Preview)** on in Devin Settings. With it off,
or on Cascade, read the agent's file and follow it yourself in this
thread.

Independent steps can go out as several subagent calls in one message.
Steps that depend on each other stay sequential.

Each agent file carries its tool grant as a line of its prompt, and
`hedgehog verify` checks the touched files against the packet's ALLOWED
SCOPE before any commit lands.

The skills in `.devin/skills/` are procedures to follow — read the one
whose situation applies rather than improvising the steps.

Clear the conversation at the unit boundaries the `hedgehog-orchestrating`
skill states.
