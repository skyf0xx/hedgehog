// Merges a core's CLAUDE.md section into a project's root instructions
// file, for the one path where that file is not a Hedgehog shell: a
// repo adopted onto existing, hand-written content that has no
// {{CORE_SECTION}} placeholder at all.
//
// `writePlannedFile` in bin/cli.mjs (the `merge` entry kind) fills
// {{CORE_SECTION}} by substring replacement, which requires the shell's
// placeholder to already be present — true for every project `init`
// ever wrote, since it always starts from src/templates/CLAUDE.md. An
// adopted repo's CLAUDE.md predates Hedgehog entirely and carries no
// such marker, so that replacement has nothing to replace. This module
// is the one place that gap is closed: appending a delimited section
// instead of substituting into one.
//
// Referenced by name (not substance) from hedgehog-adopt's own SKILL.md
// in the @skyf0xx/hedgehog-core-authored package — that skill invokes
// `appendCoreSection` the same way it already invokes `loadCore` from
// src/db/core.mjs, via `node -e "import('<path-to-hedgehog-install>/
// src/hosts/claude-md-merge.mjs')..."`.

const MARKER_START = '<!-- hedgehog:core-section start -->';
const MARKER_END = '<!-- hedgehog:core-section end -->';

// True when `content` already carries a Hedgehog-managed section — from
// either mechanism: the shell's own {{CORE_SECTION}} placeholder (still
// unfilled, or already filled by writePlannedFile's substring
// replacement — filled content stays wrapped in the same markers, so
// this check still finds it) or this module's own appended, delimited
// block.
export function hasCoreSection(content) {
  return content.includes('{{CORE_SECTION}}') || content.includes(MARKER_START);
}

// Wraps `section` (a core's CLAUDE.core.*.md content, verbatim) in the
// stable markers that make both the substring-replace path
// (writePlannedFile, bin/cli.mjs) and this append path idempotent and
// mutually recognizable. Exported so writePlannedFile's {{CORE_SECTION}}
// substitution wraps its own output the same way, rather than each path
// hand-rolling the marker text.
export function wrapSection(section) {
  return `${MARKER_START}\n\n${section.trimEnd()}\n\n${MARKER_END}`;
}

// Appends `section` to `existingContent` as a clearly delimited block,
// never touching a byte of what's already there. Idempotent: if a
// marked section is already present, its content is replaced in place
// (so a later `hedgehog-adopt` re-run, or a core switch, updates the
// section without duplicating it) rather than appending a second copy.
//
// This is the merge path for a CLAUDE.md hedgehog-adopt's Step 5 finds
// with no {{CORE_SECTION}} placeholder — the file predates Hedgehog and
// was never written from src/templates/CLAUDE.md. Every file that shell
// ever produced already has the placeholder, so that case always goes
// through writePlannedFile's ordinary substitution instead; this
// function is never called on that path.
export function appendCoreSection(existingContent, section) {
  const block = wrapSection(section);
  const markerRe = new RegExp(
    `${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}`,
  );
  if (markerRe.test(existingContent)) {
    return existingContent.replace(markerRe, block);
  }
  return `${existingContent.trimEnd()}\n\n${block}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
