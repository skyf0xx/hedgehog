# How we would like reports written

## Layout and length
- Under one page. Sections in this order: Summary, Affected component
  and versions, Attacker's starting position, Reproduction, Impact,
  Suggested fix.

## What every report should state
- The file and function where the fault is, and the CLI subcommand or
  input file that reaches it.
- Who controls the hostile input (a project file, a core package, a web
  page reaching the graph server) and why that is plausible.
- A reproduction as a shell script or a `repro/`-style `.mjs` script
  that runs against a fresh scratch git repo.

## Style
- Plain text and fenced code blocks. One root cause per report. Start
  the title with the component, for example "registry: ..." or
  "db/verify: ...".
