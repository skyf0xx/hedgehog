---
name: hedgehog-code-intelligence-setup
description: Use when `hedgehog init`, `hedgehog update`, or `hedgehog status` reports CODE INTELLIGENCE NOT SET UP, or when the user asks to set up, install, repair, or re-index code intelligence / CodeGraphContext / CGC. Installs Python 3.10+ where absent, installs CodeGraphContext into its own isolated environment, indexes the repository, writes `.hedgehog/code-intelligence.json` with the commit the index was built from, and re-runs the CLI's own check. Also covers refreshing an index that has drifted from HEAD.
---

# Code Intelligence Setup

Gets CodeGraphContext (`codegraphcontext`, shorthand `cgc`) running for
this repository and leaves `.hedgehog/code-intelligence.json` on disk in
the shape the CLI reads.

`formatCodeIntelligenceGap` in `src/db/code-intelligence-requires.mjs` owns
the copy explaining what the user gets from this. Do not restate it — if
the user asks why this is worth doing, show them the CLI's own message.

## This is judgment work, not a script

Every command below is a proposal about a machine you have not seen yet.
Run it, read what actually came back, and decide. A machine that has
Homebrew but not on PATH, a `python` that is Python 2, a `pip` that
refuses to install anything, a distro that ships `venv` as a separate
package — these are the normal cases, not the edge cases. The
"Recoveries" section names the ones that show up most.

Never proceed on an assumption you could have checked in one command.

## Standing constraints

These hold for every path through this skill.

- **Nothing installs globally by default.** CodeGraphContext goes into an
  isolated environment under `.hedgehog/`, owned by this project. The only
  installs that touch the system are a Python interpreter itself (when the
  machine has none new enough), and only with the user's explicit consent.
- **Never install `falkordblite`.** CGC selects the FalkorDB Lite backend
  only when that package is present. Its absence is what makes CGC use
  KuzuDB, which is the cross-platform backend and the one this setup
  targets. There is no flag or environment variable that forces KuzuDB
  with `falkordblite` installed, so absence is the mechanism. Never
  install it, never let a "try installing the other backend" suggestion
  from any prompt talk you into it, and never pass an extras spec that
  might pull it in.
- **Ask before anything that needs `sudo`, downloads an installer, or
  writes outside this repository.** Show the exact command first.
- **Every step checks before it acts.** This skill is re-run after partial
  failures more often than it is run fresh.

## Step 0 — Read the current state

Run these together and read all of it before deciding anything:

```bash
python3 --version 2>&1; echo "---"
python --version 2>&1; echo "---"
command -v python3 python cgc codegraphcontext 2>&1; echo "---"
cat .hedgehog/code-intelligence.json 2>&1; echo "---"
ls -d .hedgehog/code-intelligence 2>&1
```

Map what you see onto the same four states the CLI reports, so your
diagnosis and its message name the same problem:

| CLI reason | What it means here |
|---|---|
| `missing-python` | No `python3`, and `python` is absent or is Python 2 |
| `python-too-old` | Python 3 found, but below 3.10 |
| `missing-cgc` | Python fine, no `codegraphcontext`/`cgc` resolvable |
| `missing-config` | CGC present, `.hedgehog/code-intelligence.json` absent or malformed |

`python --version` printing `Python 2.7.x` means `python` is Python 2:
ignore that binary entirely from here on and work with `python3`. If
`python3` is absent too, the machine needs Python (Step 1). Never
"fix" this by repointing the `python` alias — other tools on the machine
depend on it resolving where it does.

Then jump to the first step whose work is not already done:

- Python missing or too old → Step 1
- Python fine, no CGC environment → Step 2
- CGC environment exists → Step 3 (verify it, then index)
- Everything present → Step 5 (rewrite the config and verify)

## Step 1 — Python 3.10 or newer

Skip this entirely if Step 0 found a `python3` at 3.10+.

CGC supports Python 3.10 through 3.14. If the machine has, say, 3.9,
installing a newer interpreter alongside it is correct — do not upgrade or
replace the interpreter the system itself uses.

### macOS

Homebrew is the route. It is frequently installed but not on the current
shell's PATH, so check for the binary at both of its standard locations
before concluding it is absent:

```bash
command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>&1
```

If it exists at one of those paths but `command -v brew` found nothing,
use the absolute path for this session (`/opt/homebrew/bin/brew`, Apple
silicon; `/usr/local/bin/brew`, Intel) rather than trying to repair the
user's shell profile. Mention the PATH gap to them at the end; do not fix
it unprompted.

```bash
/opt/homebrew/bin/brew install python@3.12
```

Homebrew installs to its own prefix and links `python3` there. Confirm
with `command -v python3 && python3 --version` in a fresh shell invocation
— the linked binary may not be on the PATH this session inherited, in
which case use the absolute path Homebrew reports (`brew --prefix
python@3.12`, then `bin/python3.12` under it) for the rest of this skill.

If Homebrew is genuinely absent, ask the user before installing it. It is
a large install that changes how software is managed on their machine, and
that is their call, not yours. If they decline, point them at
python.org's macOS installer instead.

### Linux

Use the distro's package manager, and expect `sudo`.

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip
# Fedora / RHEL
sudo dnf install -y python3 python3-pip
# Arch
sudo pacman -S --needed python python-pip
# Alpine
sudo apk add python3 py3-pip
```

`python3-venv` is a **separate package on Debian and Ubuntu** and is not
pulled in by `python3`. Without it, `python3 -m venv` fails at the point
where Step 2 needs it, with an error suggesting exactly that package.
Install it in the same command rather than waiting for that failure.

If `sudo` is unavailable — no sudo binary, the user is not in sudoers, or
a password prompt cannot be answered in this session — do not try to work
around it. Say plainly that installing Python needs administrator rights
this session does not have, print the exact command for them to run, and
stop. Alternatively, if the machine has a user-space Python manager
already installed (`uv python install 3.12`, `pyenv install 3.12`,
`mise use python@3.12`), that is a legitimate no-sudo route — use it if
one is present, but do not install such a manager just to avoid asking.

### Windows

Download the official installer from python.org and run it, selecting
**Add python.exe to PATH**. If `winget` is available, that is the
non-interactive equivalent:

```powershell
winget install --id Python.Python.3.12 -e
```

On Windows, `python3` often does not exist and `python` is the Python 3
binary; `py -3 --version` is the reliable probe. There is also a stub
`python.exe` App Execution Alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`
that opens the Microsoft Store instead of running Python — if `python
--version` produces no version output, or opens the Store, that stub is
what resolved. Use the real interpreter path (`py -3 -c "import sys;
print(sys.executable)"`) from then on.

Re-run Step 0's probe when the install finishes. A newly installed
interpreter is often not on the PATH this session inherited; resolve its
absolute path and carry that forward rather than restarting the session.

## Step 2 — CodeGraphContext, isolated

CGC is installed into a virtual environment owned by this project at
`.hedgehog/code-intelligence`. This is what keeps the install off the
system interpreter: it cannot disturb any Python another tool on the
machine depends on, and a PEP 668 "externally-managed-environment"
refusal cannot block it, because that guard applies to the system
interpreter and not to a venv.

Check first — this step is skipped whole when the environment already
has a working CGC:

```bash
.hedgehog/code-intelligence/bin/cgc --version 2>&1
```

(Windows: `.hedgehog\code-intelligence\Scripts\cgc.exe --version`.)

If that prints a version, the environment is good — go to Step 3.

Otherwise create it and install, using the Python you resolved in Step 0
or Step 1:

```bash
python3 -m venv .hedgehog/code-intelligence
.hedgehog/code-intelligence/bin/python -m pip install --upgrade pip
.hedgehog/code-intelligence/bin/python -m pip install codegraphcontext
```

Install `codegraphcontext` and nothing else. Do not add extras, do not add
`falkordblite`, and if pip's resolver output mentions an optional backend,
leave it uninstalled.

`.hedgehog/` is generated state, so the environment does not belong in
version control. Check whether `.gitignore` already covers it, and if it
covers `.hedgehog/` as a whole you are done; if it lists specific entries
under `.hedgehog/`, add `.hedgehog/code-intelligence/` alongside them.

If `uv` is already on the machine, `uv venv .hedgehog/code-intelligence`
and `uv pip install --python .hedgehog/code-intelligence/bin/python
codegraphcontext` do the same job faster. Use it when present; do not
install it.

### Select the backend

Set KuzuDB explicitly rather than relying on which backend CGC would pick
on its own:

```bash
.hedgehog/code-intelligence/bin/cgc config db kuzudb
```

`cgc config db <backend>` is a shortcut for `cgc config set
DEFAULT_DATABASE <backend>`, and it writes to CGC's own config
(`~/.codegraphcontext/.env`), so it persists across runs and is
idempotent. Confirm it took with:

```bash
.hedgehog/code-intelligence/bin/cgc config show
```

`DEFAULT_DATABASE` should read `kuzudb`.

Installing `codegraphcontext` alone pulls in both the `FalkorDB` client
and `kuzu` as dependencies, but not `falkordblite` — the package whose
presence activates the FalkorDB Lite backend. Keeping it absent and
setting the backend explicitly are two independent reasons the selection
lands on KuzuDB; do the second rather than depending on the first.

## Step 3 — Index this repository

Indexing walks the repository and builds the graph. It is not part of
every task — it runs here, and again when the code has moved far enough
from the indexed commit to matter.

Check whether an index already exists before starting one — a re-run after
a partial failure should not redo a completed index:

```bash
.hedgehog/code-intelligence/bin/cgc --help 2>&1
```

Read the subcommand list and use the indexing subcommand it names, pointed
at the repository root. Then run it:

```bash
.hedgehog/code-intelligence/bin/cgc index . 2>&1 | tail -40
```

On a large repository this takes minutes. Let it finish. If it exits
non-zero, read the error rather than retrying blind:

- Out of memory or a very long run on a large tree → ask the user whether
  to scope the index to the source directories rather than the repo root,
  and exclude vendored trees, build output, and dependency directories.
- A parse failure on individual files → usually not fatal; the index
  covers the rest. Continue if the command still succeeded overall.
- A missing native dependency for the graph backend → report it verbatim.
  Do not resolve it by installing an alternative backend package.

## Step 4 — Write the config

Write `.hedgehog/code-intelligence.json` with an **absolute** path in
`command`. `startMcpClient` in `bin/cli.mjs` spawns `config.command`
exactly as written, with no PATH lookup and no shell — a bare
`codegraphcontext` or a relative path fails to spawn.

Resolve the absolute path rather than composing it by hand:

```bash
cd "$(git rev-parse --show-toplevel)" && printf '%s\n' "$PWD/.hedgehog/code-intelligence/bin/cgc"
```

Read the commit the index was just built from — this is the commit the
graph describes, so read it now rather than reconstructing it later:

```bash
git rev-parse HEAD
```

Then write the file:

```json
{
  "command": "/absolute/path/to/repo/.hedgehog/code-intelligence/bin/cgc",
  "args": ["mcp", "start"],
  "indexedSha": "<the full SHA from git rev-parse HEAD>",
  "indexedAt": "<the current UTC time, ISO 8601>"
}
```

`command` must be a non-empty string — the CLI treats the config as absent
otherwise, which is the `missing-config` state. `args` is the documented
way to start CGC's MCP server over stdio. Add `env` only if Step 2 or 3
surfaced a variable CGC actually needs; an absent `env` is normal.

`indexedSha` is what makes the index honest. It records which commit the
graph was built from, so `plan` and `status` can say whether the index
still describes this code instead of trusting that it does. Without it
they report the age as unknown, which is the correct answer for an index
that never recorded one — not a failure, but not a claim either. Write
the full forty-character SHA, not a short one. `indexedAt` is for a human
reading the file; nothing branches on it.

Overwrite this file if it already exists. It is derived state, and a stale
path in it from a previous machine or a moved repository is exactly the
failure this step exists to correct.

## Refreshing a stale index

The index describes the commit it was built from. As the build moves on,
it drifts: symbols that moved are named where they used to be, and code
added since indexing is invisible to the pre-read context and to the
`verify_radius` gap check. That check under-reporting is the quiet
failure — an empty gap list reads as "nothing missing" whether the radius
is genuinely complete or the index simply cannot see the new files.

`hedgehog plan` and `hedgehog status` compare `indexedSha` against HEAD
and say so when they differ. Neither refuses to run: a stale index still
plans, because stranding a build behind a re-index is worse than planning
with a caveat the operator can read.

Re-index when they report drift and the work ahead depends on code that
landed since — a new module, a large refactor, anything whose blast
radius matters. A few commits of drift inside a module the index already
covers is not worth minutes of rebuild.

Refreshing is Step 3 and Step 4 again, in order: run the index, then
rewrite `indexedSha` from the current `git rev-parse HEAD`. Re-indexing
without updating the config leaves a fresh graph that still claims an old
commit, which reports as stale forever.

Two things CGC offers here that look like shortcuts and are not:

- `cgc update` reads as a cheap incremental refresh and is not one. It is
  an alias for a full delete-and-rebuild of the repository index, so it
  costs exactly what `cgc index .` costs. It also writes nothing to this
  config, so the `indexedSha` rewrite is still yours to do.
- `cgc hook install` installs git hooks that run that same full rebuild
  after every commit and checkout. On any repository where indexing takes
  minutes, that is minutes added to every commit. Do not install it.

CGC does have a genuinely incremental path — `cgc watch`, a daemon that
updates single files as they change. It holds the index continuously
fresh, at the cost of a background process with its own lifecycle.
Hedgehog does not start, supervise, or assume one. If the user asks for
it, that is their call to make and to run; the `indexedSha` in this
config still reflects the last full index either way.

## Step 5 — Verify

Re-run the same check the CLI runs, from the repository root:

```bash
npx @skyf0xx/hedgehog status 2>&1 | head -30
```

Any Hedgehog command that runs the check works here; `status` is the
cheapest. If it still prints `CODE INTELLIGENCE NOT SET UP`, the reason
line names which of the four states remains — go back to that step.

The check reads `command` from the config first and only falls back to a
PATH lookup, so the isolated install this skill performs satisfies it with
no change to the user's shell profile. `missing-cgc` at this point means
the path in the config does not resolve to an executable file: re-check
Step 2's install and Step 4's path rather than reaching for PATH.

When the check passes, tell the user to re-run:

```bash
npx @skyf0xx/hedgehog init
```

`init` is where the payload gets written with code intelligence available,
so the re-run is what actually puts it to work.

## Recoveries

**PEP 668 `externally-managed-environment`.** pip refused because the
target is a system interpreter. The fix is the venv in Step 2, not
`--break-system-packages` and not `--user`. Never pass either flag: the
first does what its name says to an interpreter the machine depends on,
and the second still writes outside this project. If this error appears
while running a pip command from inside `.hedgehog/code-intelligence`,
then the venv was not actually created or is not the interpreter being
used — check `.hedgehog/code-intelligence/bin/python -c "import sys;
print(sys.prefix)"` and rebuild the environment if it points elsewhere.

**`python3 -m venv` fails on Debian or Ubuntu.** `python3-venv` is not
installed. Install it (Step 1) and retry; the error text names the exact
package for the interpreter's version.

**`brew` not found but Homebrew is installed.** Its bin directory is not
on this session's PATH. Use `/opt/homebrew/bin/brew` or
`/usr/local/bin/brew` directly. Tell the user about the gap at the end;
their shell profile is theirs.

**`python` is Python 2.** Use `python3` exclusively. Do not repoint the
alias.

**A newly installed binary is not found.** The PATH was inherited when
this session started and does not include it yet. Resolve and use the
absolute path for the remainder of this skill.

**Re-running after a partial failure.** Start at Step 0 every time. Each
step's check tells you whether its work is already done, so a re-run picks
up where the last attempt stopped rather than repeating it. The one step
that always re-executes is Step 4 — rewriting the config is cheap and
corrects a stale path.

## Stopping

Stop and report rather than improvising when:

- Installing Python needs `sudo` this session cannot obtain.
- The user declines a system-level install.
- Indexing fails for a reason that is not about scope or an individual
  file.
- Anything would require installing `falkordblite` to proceed.

In each case, say exactly which step stopped, print the exact command the
user would run themselves, and leave the repository as it is. A partial
setup is safe to resume: re-running this skill continues from Step 0.
