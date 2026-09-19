// Undo for changes the agent writes to source.
//
// Approving should feel cheap, and it only does if it is reversible. Git already
// knows how to snapshot a working tree, so this uses it rather than inventing a
// file-copy scheme: `stash create` builds a commit object from the current state
// without touching the index, the worktree, or the stash list.
//
// A snapshot alone only tells us what the tree looked like *before* the agent's
// edit. To undo safely we also need what it looked like right *after* — captured
// once, when the agent's turn ends — so a later, unrelated edit to the same file
// can be told apart from the agent's own change and left alone.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (cwd, args) => {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
};

const lines = (text) => (text ? text.split("\n").map((l) => l.trim()).filter(Boolean) : []);

const untracked = (cwd) => git(cwd, ["ls-files", "--others", "--exclude-standard"]).then(lines);

const hashFile = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null; // deleted or unreadable since — treated as "changed further", never as a match
  }
};

export async function isRepo(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/**
 * A restorable point. Returns null when there is nothing to snapshot or this is
 * not a repository — callers must treat revert as unavailable rather than assume.
 */
export async function snapshot(cwd, label) {
  if (!(await isRepo(cwd))) return null;
  try {
    // With a clean tree `stash create` prints nothing; HEAD is the restore point.
    const wip = await git(cwd, ["stash", "create"]);
    const ref = wip || (await git(cwd, ["rev-parse", "HEAD"]));
    const untrackedBefore = await untracked(cwd);
    return { ref, label, at: Date.now(), untrackedBefore };
  } catch {
    return null;
  }
}

/**
 * Freeze the file contents exactly as the agent left them. Called once, right
 * when the agent's turn ends — not on any later turn, or a subsequent unrelated
 * edit would get baked in as if the agent had made it. revertTo() uses this to
 * tell "only the agent has touched this since the snapshot" apart from "someone
 * touched it again after," and to know which new files are the agent's to remove.
 */
export async function captureAfter(cwd, snap) {
  if (!snap || snap.postCaptured) return snap;

  const changedByAgent = lines(await git(cwd, ["diff", "--name-only", snap.ref, "--"]));
  const postHashes = {};
  for (const file of changedByAgent) postHashes[file] = hashFile(join(cwd, file));

  const before = new Set(snap.untrackedBefore ?? []);
  const createdByAgent = (await untracked(cwd)).filter((f) => !before.has(f));
  const createdHashes = {};
  for (const file of createdByAgent) createdHashes[file] = hashFile(join(cwd, file));

  return { ...snap, postCaptured: true, changedByAgent, postHashes, createdByAgent, createdHashes };
}

function removeEmptyParents(cwd, file) {
  const root = resolve(cwd);
  let dir = dirname(join(cwd, file));
  while (dir !== root && dir.startsWith(root)) {
    try {
      rmdirSync(dir); // throws (harmlessly) as soon as a directory still has something in it
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

/**
 * Undo, scoped to what the agent actually touched — not everything that differs
 * from the snapshot, which would also sweep up edits made elsewhere in the
 * meantime. A file the agent changed is restored only if nobody has touched it
 * again since; a file it created is removed only if nobody kept working on it.
 */
export async function revertTo(cwd, snap) {
  if (!snap?.ref) throw new Error("there is no snapshot to go back to");

  // The agent's turn hadn't ended when undo was pressed, so there is no captured
  // post-edit state to check against yet. Fall back to whatever currently
  // differs from the snapshot, restored in full, rather than refuse outright.
  if (!snap.postCaptured) {
    const changed = lines(await git(cwd, ["diff", "--name-only", snap.ref, "--"]));
    if (!changed.length) return { reverted: [], removed: [], skipped: [], note: "nothing has changed since that point" };
    await git(cwd, ["checkout", snap.ref, "--", ...changed]);
    return { reverted: changed, removed: [], skipped: [] };
  }

  const reverted = [];
  const skipped = [];
  for (const file of snap.changedByAgent ?? []) {
    if (hashFile(join(cwd, file)) === snap.postHashes?.[file]) reverted.push(file);
    else skipped.push(file);
  }

  const removed = [];
  for (const file of snap.createdByAgent ?? []) {
    const full = join(cwd, file);
    if (!existsSync(full)) continue; // already gone; nothing to undo
    if (hashFile(full) === snap.createdHashes?.[file]) removed.push(file);
    else skipped.push(file);
  }

  if (reverted.length) await git(cwd, ["checkout", snap.ref, "--", ...reverted]);
  for (const file of removed) {
    unlinkSync(join(cwd, file));
    removeEmptyParents(cwd, file);
  }

  if (!reverted.length && !removed.length) {
    return {
      reverted,
      removed,
      skipped,
      note: skipped.length
        ? "every file the agent changed was edited again since — nothing was safe to revert"
        : "nothing has changed since that point",
    };
  }
  return { reverted, removed, skipped };
}

/** What changed since the snapshot, for showing before reverting. */
export async function changedSince(cwd, snap) {
  if (!snap?.ref || !(await isRepo(cwd))) return [];
  try {
    return (await git(cwd, ["diff", "--stat", snap.ref, "--"])).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
