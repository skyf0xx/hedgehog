## Affected Projects

Find projects affected by changes in the current branch.

```bash
# Affected since base branch (auto-detected)
pnpm nx show projects --affected

# Affected with explicit base
pnpm nx show projects --affected --base=main
pnpm nx show projects --affected --base=origin/main

# Affected between two commits
pnpm nx show projects --affected --base=abc123 --head=def456

# Affected apps only
pnpm nx show projects --affected --type app

# Affected excluding e2e projects
pnpm nx show projects --affected --exclude="*-e2e"

# Affected by uncommitted changes
pnpm nx show projects --affected --uncommitted

# Affected by untracked files
pnpm nx show projects --affected --untracked
```
