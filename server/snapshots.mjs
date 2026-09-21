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
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
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
 * Of the given project-relative paths, the ones git ignores. A snapshot captures
 * tracked files (via the ref) and untracked-but-not-ignored files (blobbed), and
 * `git diff` never lists an ignored path — so an ignored file an edit touched is in
 * none of undo's buckets and cannot be restored. Undo must SAY so rather than
 * silently drop it, so this lets a caller name the uncoverable paths. Batched;
 * `check-ignore` exits non-zero when none match, which surfaces as [].
 */
export async function ignoredPaths(cwd, files) {
  if (!files?.length) return [];
  try {
    return lines(await git(cwd, ["check-ignore", "--", ...files]));
  } catch {
    return []; // exit 1 = nothing ignored (or not a repo) — nothing to warn about
  }
}

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

// Does the path exist as an entry of any kind? existsSync follows symlinks, so a
// dangling one reads as absent — lstat sees the link itself, which is what "was
// this file deleted?" actually means for an untracked symlink.
const lexists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// What an untracked entry IS, captured with lstat so a symlink is recorded as a
// link (its target), not followed. git hash-object follows a symlink and stores the
// TARGET's bytes, so restoring from a blob would turn the link into a regular file —
// silently changing filesystem topology. A regular file also carries its mode, so
// undo can put an executable bit back (writeFileSync alone would drop it). The
// content hash lets a later user edit be told apart from the agent's own change.
const entryMeta = (path) => {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { type: "link", target: readlinkSync(path) };
    if (st.isFile()) return { type: "file", mode: st.mode & 0o777, hash: hashFile(path) };
    return { type: "other" }; // fifo/socket/etc — no bytes we can meaningfully restore
  } catch {
    return null; // gone or unreadable
  }
};

// A comparable, TYPE-AWARE fingerprint of a filesystem entry as it is right now: the
// link target for a symlink (read with lstat, so a dangling one still fingerprints and
// is never followed), the content hash for a regular file, and a bare type marker for a
// directory or anything else. Two entries only ever compare equal when they are the
// same type AND the same identity — a regular file and a symlink whose target happens
// to hold the same bytes never match. null means the path is absent. Used everywhere
// undo asks "is what's here now still exactly what the agent left?" — tracked, created
// and pre-existing-untracked alike — so those checks can no longer disagree.
const currentFingerprint = (path) => {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `L:${readlinkSync(path)}`;
    if (st.isDirectory()) return "D:";
    if (st.isFile()) return `F:${hashFile(path)}`;
    return "O:"; // fifo/socket/device — no content identity we can compare
  } catch {
    return null; // absent
  }
};

// The same fingerprint derived from stored snapshot meta, so before/after compare
// on the same footing (a symlink that becomes a same-content regular file, or a
// retargeted link, both read as "changed").
const metaFingerprint = (m) => (!m ? null : m.type === "link" ? `L:${m.target}` : `F:${m.hash}`);

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
    // agent later edits has no restore point in `ref`. Record what each one IS
    // (regular file with its mode, or a symlink with its target) and, for regular
    // files, keep the bytes as a git blob now, before any edit, so undo can put it
    // back exactly. Symlinks are deliberately NOT hash-object'd — that would follow
    // the link and blob the target's bytes; their target string is the restore point.
    const untrackedMeta = {};
    const regularFiles = [];
    for (const f of untrackedBefore) {
      const meta = entryMeta(join(cwd, f));
      untrackedMeta[f] = meta;
      if (meta && meta.type !== "link") regularFiles.push(f);
    }
    const untrackedBlobs = await blobIds(cwd, regularFiles, { write: true });
    return { ref, label, at: Date.now(), untrackedBefore, untrackedBlobs, untrackedMeta };
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

  // Fingerprint what the agent left with the same type-aware measure used for
  // untracked entries — NOT a plain content hash. A content hash follows a symlink,
  // so a tracked symlink the user later retargets to a same-content file (or a
  // dangling one) would read as unchanged and be silently overwritten by undo.
  const changedByAgent = scope(lines(await git(cwd, ["diff", "--name-only", snap.ref, "--"])));
  const postFps = {};
  for (const file of changedByAgent) postFps[file] = currentFingerprint(join(cwd, file));

  const before = new Set(snap.untrackedBefore ?? []);
  const createdByAgent = scope((await untracked(cwd)).filter((f) => !before.has(f)));
  const createdFps = {};
  for (const file of createdByAgent) createdFps[file] = currentFingerprint(join(cwd, file));

  // A pre-existing untracked entry the agent changed in place: its bytes edited, a
  // symlink retargeted, or its very type swapped (file <-> symlink). git diff never
  // lists it (untracked) and it is not "created" (it predates the snapshot), so it
  // needs its own bucket. Detection is by a type-aware fingerprint, not bytes alone,
  // so replacing a symlink with a same-content file still counts. Freeze the post-edit
  // fingerprint to tell a later user edit apart from the agent's own change.
  const stillUntracked = scope((snap.untrackedBefore ?? []).filter((f) => lexists(join(cwd, f))));
  const modifiedUntracked = [];
  const modifiedFps = {};
  for (const file of stillUntracked) {
    const was = metaFingerprint(snap.untrackedMeta?.[file]);
    const now = currentFingerprint(join(cwd, file));
    if (was !== null && now !== null && now !== was) {
      modifiedUntracked.push(file);
      modifiedFps[file] = now;
    }
  }

  // A pre-existing untracked entry the agent DELETED. It no longer exists, so git
  // diff and untracked() both miss it, but its type (and, for a file, its bytes) were
  // captured at snapshot time, so undo can put it back. No post-fingerprint is kept:
  // a gone entry has nothing to fingerprint, and its concurrency rule is "restore only
  // if still absent at undo" — a path the user has since recreated is theirs.
  const deletedUntracked = scope((snap.untrackedBefore ?? []).filter((f) => !lexists(join(cwd, f))));

  return {
    ...snap, postCaptured: true, changedByAgent, postFps, createdByAgent, createdFps,
    modifiedUntracked, modifiedFps, deletedUntracked,
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
    // Type-aware: a tracked symlink the user retargeted (even to a same-content file)
    // no longer matches, so git restore never overwrites their later change.
    if (currentFingerprint(join(cwd, file)) === snap.postFps?.[file]) fromRef.push(file);
    else skipped.push(file);
  }

  const removed = [];
  for (const file of snap.createdByAgent ?? []) {
    const full = join(cwd, file);
    if (!lexists(full)) continue; // already gone (lexists, so a dangling symlink still counts as present)
    // Remove only if the entry is still exactly what the agent created — same type and
    // identity. A dangling symlink the agent made is removed; a symlink the user has
    // since retargeted, or an entry whose type they changed, is left alone.
    if (currentFingerprint(full) === snap.createdFps?.[file]) removed.push(file);
    else skipped.push(file);
  }

  // Can this untracked entry be put back? A symlink needs its recorded target; a
  // regular file needs the blob captured at snapshot time.
  const restorable = (file) => {
    const meta = snap.untrackedMeta?.[file];
    return meta?.type === "link" ? meta.target != null : Boolean(snap.untrackedBlobs?.[file]);
  };

  // Untracked entries the agent changed in place are not in the ref, so they come
  // back from the captured meta/blob rather than by checkout — but only if the user
  // has not touched them again since the agent finished (fingerprint still matches).
  const fromCapture = [];
  for (const file of snap.modifiedUntracked ?? []) {
    if (restorable(file) && currentFingerprint(join(cwd, file)) === snap.modifiedFps?.[file]) fromCapture.push(file);
    else skipped.push(file);
  }

  // A pre-existing untracked entry the agent deleted: restore it, but only if the
  // path is still absent — one the user has since put back is theirs, left untouched
  // (the same concurrency rule as an edited-again entry).
  const restoreDeleted = [];
  for (const file of snap.deletedUntracked ?? []) {
    if (restorable(file) && !lexists(join(cwd, file))) restoreDeleted.push(file);
    else skipped.push(file);
  }

  // Restore the worktree only — the agent's edit is undone, the user's staging is
  // left exactly as they had it (see the header note on the index invariant).
  if (fromRef.length) await git(cwd, ["restore", `--source=${snap.ref}`, "--worktree", "--", ...fromRef]);
  reverted.push(...fromRef);
  // Both buckets are recreated from their captured meta: a symlink from its target
  // (never a regular file with the target's bytes), a regular file from its blob with
  // its original mode. A deleted entry's parent directory may have gone with it, so
  // recreate it first; anything still present is removed first so we recreate the
  // original TYPE rather than writing through a leftover symlink or over a wrong-type
  // entry. A modified entry still exists, so its directory does too.
  for (const file of [...fromCapture, ...restoreDeleted]) {
    const full = join(cwd, file);
    const meta = snap.untrackedMeta?.[file];
    try {
      mkdirSync(dirname(full), { recursive: true });
      if (lexists(full)) unlinkSync(full);
      if (meta?.type === "link") {
        symlinkSync(meta.target, full);
      } else {
        const { stdout } = await run("git", ["cat-file", "blob", snap.untrackedBlobs[file]], {
          cwd,
          encoding: "buffer",
          maxBuffer: 1024 * 1024 * 64,
        });
        writeFileSync(full, stdout);
        if (meta?.mode != null) chmodSync(full, meta.mode); // put an executable bit back
      }
      reverted.push(file);
    } catch {
      skipped.push(file); // blob gc'd, or the entry can't be recreated — leave it rather than fail the whole undo
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
