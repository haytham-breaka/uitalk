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
//
// Undo restores the *worktree* to the pre-edit state; it must never touch the
// user's index. Their staging is theirs — a half-staged file, a `git add`ed hunk —
// and clicking Undo on an agent's edit should not restage, unstage, or collapse
// any of it. That is why revert uses `git restore --worktree` (worktree only) and
// not `git checkout <ref> -- <path>` (which rewrites the index too).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (cwd, args) => {
  // core.quotePath=false stops git octal-quoting non-ASCII paths (café.css ->
  // "caf\303\251.css"); left quoted, that string flows into hash-object and
  // checkout as a bogus pathspec, so an accented filename was silently un-undoable.
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], { cwd, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
};

const lines = (text) => (text ? text.split("\n").map((l) => l.trim()).filter(Boolean) : []);

const untracked = (cwd) => git(cwd, ["ls-files", "--others", "--exclude-standard"]).then(lines);

/**
 * git's blob id for each file's current contents. With write:true the contents
 * are also stored in the object database, so the exact bytes can be recovered
 * later even though nothing in the tree references them — the same unreferenced
 * lifetime the stash-create commit already relies on. Lets undo restore an
 * untracked file git itself never tracked, without holding its bytes in memory.
 * --no-filters keeps the bytes verbatim: no EOL/clean filter from .gitattributes,
 * so what goes in is what comes back out, and the id is a raw-byte comparison.
 */
async function blobIds(cwd, files, { write = false } = {}) {
  const args = write ? ["hash-object", "-w", "--no-filters", "--"] : ["hash-object", "--no-filters", "--"];
  const out = {};
  await Promise.all(
    files.map(async (f) => {
      try {
        out[f] = await git(cwd, [...args, f]);
      } catch {
        out[f] = null; // vanished or unreadable — no baseline to keep for it
      }
    }),
  );
  return out;
}

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
export async function snapshot(cwd, label, onError = null) {
  if (!(await isRepo(cwd))) return null;
  try {
    // With a clean tree `stash create` prints nothing; HEAD is the restore point.
    const wip = await git(cwd, ["stash", "create"]);
    const ref = wip || (await git(cwd, ["rev-parse", "HEAD"]));
    const untrackedBefore = await untracked(cwd);
    // stash create captures only tracked files, so an already-untracked file the
    // agent later edits has no restore point in `ref`. Keep each one's contents
    // as a git blob now, before any edit, so undo can put it back exactly.
    const untrackedBlobs = await blobIds(cwd, untrackedBefore, { write: true });
    return { ref, label, at: Date.now(), untrackedBefore, untrackedBlobs };
  } catch (err) {
    // A git operation failed on a tree we already confirmed is a repo — a
    // transient spawn failure, an odd filesystem, a locale that trips path
    // handling. Undo becomes unavailable for this change either way, but the
    // reason must not vanish: swallowing it silently is what made an intermittent
    // failure impossible to diagnose. Surface it and let the caller log.
    onError?.(err);
    return null;
  }
}

/**
 * Freeze the file contents exactly as the agent left them. Called once, right
 * when the agent's turn ends — not on any later turn, or a subsequent unrelated
 * edit would get baked in as if the agent had made it. revertTo() uses this to
 * tell "only the agent has touched this since the snapshot" apart from "someone
 * touched it again after," and to know which new files are the agent's to remove.
 *
 * `touched` is the set of paths the agent is known to have written this turn (from
 * its own tool calls). When given, the buckets are scoped to it: a file the user
 * edited concurrently during the turn differs from the snapshot too, but the agent
 * never wrote it, so it must not be undone. Intersecting with the diff means a path
 * the agent only read never counts. When it is empty (an MCP client, or an edit
 * made through a tool the bridge cannot see) the scope falls back to the whole
 * diff — the same best-effort behaviour as before.
 */
export async function captureAfter(cwd, snap, touched = null) {
  if (!snap || snap.postCaptured) return snap;

  const only = touched?.length ? new Set(touched) : null;
  const scope = (files) => (only ? files.filter((f) => only.has(f)) : files);

  const changedByAgent = scope(lines(await git(cwd, ["diff", "--name-only", snap.ref, "--"])));
  const postHashes = {};
  for (const file of changedByAgent) postHashes[file] = hashFile(join(cwd, file));

  const before = new Set(snap.untrackedBefore ?? []);
  const createdByAgent = scope((await untracked(cwd)).filter((f) => !before.has(f)));
  const createdHashes = {};
  for (const file of createdByAgent) createdHashes[file] = hashFile(join(cwd, file));

  // A file that was already untracked and whose bytes the agent changed since the
  // snapshot. git diff never lists it (it is untracked) and it is not "created"
  // (it predates the snapshot), so it needs its own bucket. Freeze the post-edit
  // hash too, to tell a later user edit apart from the agent's own change.
  const stillUntracked = scope((snap.untrackedBefore ?? []).filter((f) => existsSync(join(cwd, f))));
  const nowBlobs = await blobIds(cwd, stillUntracked);
  const modifiedUntracked = [];
  const modifiedHashes = {};
  for (const file of stillUntracked) {
    const baseline = snap.untrackedBlobs?.[file];
    if (baseline && nowBlobs[file] && nowBlobs[file] !== baseline) {
      modifiedUntracked.push(file);
      modifiedHashes[file] = hashFile(join(cwd, file));
    }
  }

  // A pre-existing untracked file the agent DELETED. It no longer exists, so git
  // diff and untracked() both miss it, but its bytes were blobbed at snapshot time,
  // so undo can put it back. No post-hash is kept: a gone file has no content to
  // fingerprint, and its concurrency rule is "restore only if still absent at undo"
  // — a path the user has since recreated is theirs, and revertTo() leaves it alone.
  const deletedUntracked = scope((snap.untrackedBefore ?? []).filter((f) => !existsSync(join(cwd, f))));

  return {
    ...snap, postCaptured: true, changedByAgent, postHashes, createdByAgent, createdHashes,
    modifiedUntracked, modifiedHashes, deletedUntracked,
  };
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
    // --worktree, never checkout: restore the files without rewriting the index.
    await git(cwd, ["restore", `--source=${snap.ref}`, "--worktree", "--", ...changed]);
    return { reverted: changed, removed: [], skipped: [] };
  }

  const reverted = [];
  const skipped = [];
  const fromRef = []; // tracked files, restorable straight from the snapshot ref
  for (const file of snap.changedByAgent ?? []) {
    if (hashFile(join(cwd, file)) === snap.postHashes?.[file]) fromRef.push(file);
    else skipped.push(file);
  }

  const removed = [];
  for (const file of snap.createdByAgent ?? []) {
    const full = join(cwd, file);
    if (!existsSync(full)) continue; // already gone; nothing to undo
    if (hashFile(full) === snap.createdHashes?.[file]) removed.push(file);
    else skipped.push(file);
  }

  // Untracked-and-modified files are not in the ref, so they are restored from the
  // blob captured at snapshot time rather than by checkout — but only if the user
  // has not edited them again since the agent finished.
  const fromBlob = [];
  for (const file of snap.modifiedUntracked ?? []) {
    const blob = snap.untrackedBlobs?.[file];
    if (blob && hashFile(join(cwd, file)) === snap.modifiedHashes?.[file]) fromBlob.push(file);
    else skipped.push(file);
  }

  // A pre-existing untracked file the agent deleted: restore it from the snapshot
  // blob, but only if the path is still absent — a file the user has since put back
  // is theirs, left untouched (the same concurrency rule as an edited-again file).
  const restoreDeleted = [];
  for (const file of snap.deletedUntracked ?? []) {
    const blob = snap.untrackedBlobs?.[file];
    if (blob && !existsSync(join(cwd, file))) restoreDeleted.push(file);
    else skipped.push(file);
  }

  // Restore the worktree only — the agent's edit is undone, the user's staging is
  // left exactly as they had it (see the header note on the index invariant).
  if (fromRef.length) await git(cwd, ["restore", `--source=${snap.ref}`, "--worktree", "--", ...fromRef]);
  reverted.push(...fromRef);
  // Both buckets come back from their captured blob. A deleted file's parent
  // directory may have gone with it, so recreate it first; a modified file still
  // exists, so its directory does too and the mkdir is a harmless no-op.
  for (const file of [...fromBlob, ...restoreDeleted]) {
    try {
      const { stdout } = await run("git", ["cat-file", "blob", snap.untrackedBlobs[file]], {
        cwd,
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 64,
      });
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), stdout);
      reverted.push(file);
    } catch {
      skipped.push(file); // the blob is gone (gc'd) — better to leave the file than to fail the whole undo
    }
  }
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
