# Desktop app blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
desktop app system shape. Adapt it for the project at hand — the
adaptation points below are expected, not exceptions — and record what
changed in `core-design.md`'s rationale.

```
ipc      — the typed contract between the privileged process and the UI process
main     — privileged-process logic: filesystem, OS integration, windows, auto-update, native menus
domain   — the app's own logic, running in whichever process owns it, with no window or IPC knowledge
renderer — the UI, reaching the privileged process only through ipc
```

## Adaptation points

- Merge `domain` into `main` for an app whose logic is mostly OS
  orchestration (a launcher, a sync daemon with a thin window) — there's
  no separable domain to isolate.
- Add a `persistence` layer between `main` and `domain`, depending on
  `domain`, when the app owns a real local store (SQLite, a document
  format) rather than plain preference files.
- On a native stack (Swift/AppKit, C#/WinUI) the `ipc` layer disappears —
  there's one process. Keep `domain` separate from `renderer` regardless;
  that boundary is what survives a platform's UI framework changing.

## Boundary that must hold

`renderer` never touches the filesystem, spawns processes, or reads
secrets directly — every privileged operation crosses `ipc` to `main`.
This is a security boundary before it's an architectural one: a renderer
running remote or user-supplied content with direct privileged access is
the standard desktop-app vulnerability, and the layer split is what keeps
the privileged surface small enough to audit.
