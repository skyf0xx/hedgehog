## Delegating on this host

`invoke_agent` dispatches to a generalist — the role travels in the
prompt. To delegate to an agent named in this file or in `AGENTS.md`:

1. Read `.gemini/agents/<name>.md` in full.
2. Call `invoke_agent` with `agent_name: "generalist"`, passing that
   file's **entire body** as the prompt, followed by the `hedgehog next`
   packet in full.

The file is the role — pass it whole rather than summarizing it, and pass
the packet rather than a step name.

Independent steps can go out as several `invoke_agent` calls in one
response. Steps that depend on each other stay sequential.

Each agent file opens with the tools that role may use. A dispatched
generalist keeps that constraint by reading it, and `hedgehog verify`
checks the touched files against the packet's ALLOWED SCOPE before any
commit lands.

The skills in `.gemini/skills/` are procedures to follow — read the one
whose situation applies rather than improvising the steps.

Clear the conversation at the unit boundaries described above —
`hedgehog boundary` tells you whether you're at one (exit 0), and
`hedgehog boundary --handoff` is what the next session starts from.

@./AGENTS.md
