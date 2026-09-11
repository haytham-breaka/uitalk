// Undo for changes the agent writes to source.
//
// Approving should feel cheap, and it only does if it is reversible. Git already
// knows how to snapshot a working tree, so this uses it rather than inventing a
// file-copy scheme: `stash create` builds a commit object from the current state
// without touching the index, the worktree, or the stash list.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (cwd, args) => {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
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
    return { ref, label, at: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Restore the files that changed since a snapshot, and only those: a blanket
 * checkout would also throw away edits made elsewhere in the meantime.
 */
export async function revertTo(cwd, snap) {
  if (!snap?.ref) throw new Error("there is no snapshot to go back to");

  const changed = (await git(cwd, ["diff", "--name-only", snap.ref, "--"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!changed.length) return { reverted: [], note: "nothing has changed since that point" };

  await git(cwd, ["checkout", snap.ref, "--", ...changed]);
  return { reverted: changed };
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
