// `hedgehog ready` — read-only preview of claim.mjs's fan-out: which ready
// tasks would be claimable in one `hedgehog claim` call right now, and
// which are held back by a conflict with one already in that batch. See
// hedgehog-persistent-build-graph.md, "Claims" / concurrent execution, for
// the exclusive/scope/verify ordering this mirrors. Claims nothing —
// claimTasks in claim.mjs is the only writer.

import { findClaimableTasks, findInFlightTasks } from './claim.mjs';
import { conflicts, verifyRadius } from './conflict.mjs';

// Walks the same candidates claimTasks would, in the same priority/id
// order, greedily sorting each into CLAIMABLE (doesn't conflict with
// anything already CLAIMABLE or already in flight) or HELD BACK (does) —
// the same simulation claimTasks's fan-out performs, minus the atomic
// UPDATE. In-flight tasks (building/verifying) are seeded in up front so a
// candidate that conflicts with real work already running is correctly
// HELD BACK, not just against other candidates in this batch. `reason`
// records which task the conflict is against and its kind, for
// formatReady to render.
export function readyTasks(db) {
  const candidates = findClaimableTasks(db);
  const inFlight = findInFlightTasks(db);
  const claimable = [];
  const heldBack = [];

  for (const candidate of candidates) {
    let conflict = null;
    for (const accepted of [...inFlight, ...claimable]) {
      const kind = conflicts(candidate, accepted);
      if (kind !== null) {
        conflict = { with: accepted, kind };
        break;
      }
    }

    if (conflict === null) {
      claimable.push(candidate);
    } else {
      heldBack.push({ task: candidate, conflict });
    }
  }

  return { claimable, heldBack };
}

// Renders one HELD BACK reason. `exclusive` splits on which side of the
// pair is exclusive: the candidate itself (runs alone, full stop) vs. the
// already-CLAIMABLE task it lost the slot to (named, so the reason points
// at what's actually occupying the batch). Exported for status.mjs, which
// annotates the same held-back tasks inline in its own READY section
// rather than duplicating this formatting.
export function heldBackReason(candidate, conflict) {
  const { with: other, kind } = conflict;

  if (kind === 'exclusive') {
    if (candidate.exclusive) return 'exclusive — runs alone';
    return `blocked by ${other.id} — exclusive, runs alone`;
  }

  if (kind === 'scope') {
    return `conflicts with ${other.id} (scope)`;
  }

  // 'verify' — name the candidate's own verify radius, since that's the
  // side this task actually declared.
  const radius = verifyRadius(candidate).join(', ');
  return `conflicts with ${other.id} (verify radius: ${radius})`;
}

// Renders a readyTasks() result into the READY / CLAIMABLE / HELD BACK
// format.
export function formatReady({ claimable, heldBack }) {
  const total = claimable.length + heldBack.length;
  const lines = [];
  lines.push(`READY  ${total} task(s), ${claimable.length} claimable now`);
  lines.push('');

  lines.push('CLAIMABLE');
  if (claimable.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of claimable) {
      lines.push(`  ${task.id.padEnd(20)}${task.layer.padEnd(13)}priority ${task.priority}`);
    }
  }

  if (heldBack.length > 0) {
    lines.push('');
    lines.push('HELD BACK');
    for (const { task, conflict } of heldBack) {
      lines.push(`  ${task.id.padEnd(20)}${task.layer.padEnd(13)}${heldBackReason(task, conflict)}`);
    }
  }

  return lines.join('\n');
}
