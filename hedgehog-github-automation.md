# Hedgehog GitHub Automation

Free GitHub features and Actions that can be added to improve PR review, security, and issue management.

## 1. CI

**Workflow:** `.github/workflows/ci.yml`

Run on every pull request:

- Install dependencies
- Lint
- Typecheck
- Test
- Build

Purpose: ensure every PR passes the project's basic quality gates.

---

## 2. PR Policy

**Workflow:** `.github/workflows/pr-policy.yml`

Automatically check:

- Conventional PR title
- Merge conflicts
- Required checks
- Required tests
- Forbidden file changes
- Repository-specific architectural rules

### Suggested failures

- PR has merge conflicts
- Invalid PR title
- New `package.json` in an unexpected location
- Changes violate repository structure
- Required checks are missing

---

## 3. PR Risk Labelling

**Workflow:** `.github/workflows/pr-risk.yml`

Automatically add labels based on the files and changes in a PR.

### Dependency risk

Label: `risk:dependencies`

Trigger when:

- A new `package.json` is added
- `pnpm-lock.yaml` changes
- A dependency is added or removed
- Package manager configuration changes
- Package scripts change

### Agent risk

Label: `risk:agents`

Trigger when:

- `.claude/` changes
- `.claude/agents/` changes
- `.claude/skills/` changes
- `CLAUDE.md` changes

### CI risk

Label: `risk:ci`

Trigger when:

- `.github/workflows/` changes
- GitHub Actions are added or modified
- Workflow permissions change

### Architecture risk

Label: `risk:architecture`

Trigger when:

- `nx.json` changes
- Workspace configuration changes
- Project configuration changes
- Repository structure changes
- New packages/projects are introduced

### Data risk

Label: `risk:data`

Trigger when:

- Database schema changes
- Migrations are added/modified
- Seed data changes

### Execution risk

Label: `risk:execution`

Trigger when:

- Shell execution is introduced
- `child_process` usage changes
- `eval` / dynamic code execution is introduced
- Docker build/execution configuration changes

### Vendor risk

Label: `risk:vendor`

Trigger when:

- `vendor-skills/BMAD/` changes

`vendor-skills/BMAD/` is only meant to change via the `bmad-revendor` skill against a pinned upstream commit. A direct edit inside this tree is almost always unintentional or out of process and should be flagged for maintainer review rather than merged as a normal contribution.

### Large PR

Label: `risk:large`

Trigger when a PR exceeds configurable thresholds, for example:

- More than 50 files
- More than 1,000 changed lines

Large PRs should generally be flagged rather than automatically rejected.

---

## 4. Dependency Review

**Workflow:** `.github/workflows/dependency-review.yml`

Use GitHub's Dependency Review Action to inspect dependency changes in PRs.

Check for:

- New vulnerable dependencies
- New transitive vulnerabilities
- Dependency additions
- Dependency removals

Consider failing the PR when a dependency introduces a known high-severity vulnerability.

---

## 5. Dependabot

**File:** `.github/dependabot.yml`

Enable automatic dependency update PRs.

Useful for:

- npm/pnpm dependencies
- GitHub Actions dependencies
- Keeping security patches current

Suggested configuration:

- Weekly updates
- Group minor/patch updates where practical
- Separate security updates when necessary

---

## 6. CodeQL

**Workflow:** `.github/workflows/codeql.yml`

Run GitHub CodeQL analysis for JavaScript/TypeScript.

Detect classes of issues such as:

- Injection vulnerabilities
- Unsafe data flow
- Authentication/authorization mistakes
- Dangerous APIs
- Other common security problems

Run on:

- Pull requests
- Pushes to the default branch
- A scheduled weekly scan

---

## 7. Secret Scanning

Enable GitHub secret scanning for the repository.

Look for accidentally committed:

- API keys
- Tokens
- Private credentials
- Cloud credentials
- Other known secret formats

This is particularly important for an open-source repository receiving external PRs.

---

## 8. GitHub Actions Security

Keep workflow permissions minimal.

Prefer:

```yaml
permissions:
  contents: read
```

Only grant additional permissions to individual jobs when required.

### Important rule

Avoid using `pull_request_target` to execute untrusted PR code.

Be especially careful when workflows:

- Check out PR code
- Execute scripts from the PR
- Have access to repository secrets
- Have write permissions

Any workflow modification should receive:

`risk:ci`

---

## 9. Conventional Commit / PR Title Enforcement

Use a GitHub Action to enforce the project's conventional commit/PR title convention.

Examples:

```text
feat: add generator
fix: handle invalid schema
refactor: simplify dependency graph
docs: update architecture guide
test: add generator coverage
ci: update workflow
chore: update dependencies
```

Lefthook can catch this locally, while GitHub Actions enforces it for external contributors.

---

## 10. PR Size Labels

Automatically add labels such as:

```text
size:xs
size:s
size:m
size:l
size:xl
```

Example thresholds:

```text
XS   < 10 lines
S    < 100 lines
M    < 500 lines
L    < 1,000 lines
XL   >= 1,000 lines
```

These are useful for triage without blocking contributors.

---

## 11. First-Time Contributor Label

Automatically label PRs from contributors who have never previously contributed.

Label:

```text
first-time-contributor
```

This makes it immediately visible when a PR needs extra maintainer attention.

---

## 12. Automatic Issue Labels

Use GitHub Actions to automatically classify issues using simple rules and/or issue templates.

Useful labels:

```text
bug
feature
question
documentation
good-first-issue
needs-reproduction
needs-more-information
```

Issue templates should collect the information required to reproduce bugs before maintainers spend time investigating them.

---

## 13. Stale Issues and PRs

Use GitHub's stale workflow to identify inactive:

- Issues
- Pull requests

Suggested behavior:

1. Mark inactive issues/PRs after a configurable period.
2. Add a warning comment.
3. Close only after a further period of inactivity.

Avoid being too aggressive with PRs from external contributors.

---

# Recommended Hedgehog Labels

A useful starting set:

```text
risk:dependencies
risk:agents
risk:ci
risk:architecture
risk:data
risk:execution
risk:vendor
risk:large

size:xs
size:s
size:m
size:l
size:xl

first-time-contributor

needs-tests
needs-docs
needs-reproduction
needs-maintainer-review
```

# Recommended Initial Setup

Start with these before adding anything more sophisticated:

1. **CI**
2. **Dependency Review**
3. **Dependabot**
4. **CodeQL**
5. **Secret scanning**
6. **Merge-conflict check**
7. **PR risk labelling**
8. **Conventional PR title check**
9. **First-time contributor label**
10. **Issue templates**

The most Hedgehog-specific pieces are **PR risk labelling**, **architecture enforcement**, **agent-change detection**, and **vendor-change detection**. These turn Hedgehog's development philosophy into automated repository policy rather than relying on maintainers to remember the rules.
