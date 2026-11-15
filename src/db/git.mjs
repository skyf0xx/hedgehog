// Runs git with an argv array and no shell, so every element of `args`
// reaches git as one literal argument. Paths, pathspec globs and commit
// messages all pass through verbatim: git's own pathspec magic
// (`:(glob)…`) still works, while shell metacharacters in a file name or
// a core.yaml field are just characters.

import { execFileSync } from 'node:child_process';

export function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}
