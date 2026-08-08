## Delegating on this host

The agents in `.claude/agents/` are registered automatically — delegate to
one by name (`backend-eng`, `reviewer`, and so on) and it runs in its own
context with its own tool grant. The skills in `.claude/skills/` are
available the same way; invoke one by name rather than reimplementing what
it describes.

Clear context with `/clear` at the unit boundaries described above —
`hedgehog boundary` tells you whether you're at one (exit 0), and
`hedgehog boundary --handoff` is what the next session starts from.
