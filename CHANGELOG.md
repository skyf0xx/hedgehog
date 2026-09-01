# Changelog

Every release of the `@skyf0xx/hedgehog` npm package is tagged and published
with generated release notes:

**https://github.com/skyf0xx/hedgehog/releases**

Each release is tagged `v<version>`, matching `package.json`'s `version`
field, and its notes list the merged pull requests included since the
previous release. See [ARCHITECTURE.md](ARCHITECTURE.md) and this repo's
`CLAUDE.md` for how the release process itself works.

The Claude Code plugin, Cursor plugin, and Gemini CLI extension ship from
the same repo under their own version in `.claude-plugin/plugin.json` /
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, and root
`gemini-extension.json` — their changes land in the same PRs and release
notes above rather than a separate log.

Each core (`full-stack-app`, `pwa-app`, `landing-page`,
`deepseek-harness`) ships as its own npm package from its own repo, with
its own release notes — see that core's `repository` link in
[`src/registry/cores.json`](src/registry/cores.json).
