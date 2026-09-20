// A cross-process mutex on a single lock file, used to serialize a read-modify-write
// (or a check-then-act) that several uitalk processes could otherwise run at once.
//
// The lock file is created by hard-linking a temp file that ALREADY holds the
// owner's pid, exactly as server/token.mjs elects its writer. link() is atomic and
// fails with EEXIST when the target exists, so exactly one caller wins — and the
// target, the instant it appears, is a link to fully written content. That closes
// the window an open(path,"wx")+later-write() leaves: there, the file exists but is
// still empty for a moment, so a second process can read it as blank, mistake it for
// a stale lock, and delete a valid one. Here a reader never sees an empty lock.
//
// Stale recovery: the lock is held only for the critical section and always released.
// The one way it lingers is a process that crashed while holding it; the next caller
// finds the holder pid dead and clears the lock. That clear is safe against a live
// holder: link() cannot replace an existing file, so while a stale lock physically
// sits there no other process can have taken it — the file we move aside is always
// the dead holder's, never a live one's.

import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// One attempt to take the lock. Returns true if we now hold it, false if a live
// holder has it (a stale one is cleared here so the next attempt can succeed).
function tryAcquire(lockPath) {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    writeSync(fd, String(process.pid)); // the temp file is fully populated BEFORE it is linked
    closeSync(fd);
    try {
      linkSync(tmp, lockPath); // atomic: lockPath appears already holding a real pid, or not at all
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  // The lock exists. Read who holds it; a live holder means genuinely busy.
  let holder = NaN;
  try {
    holder = Number(readFileSync(lockPath, "utf8").trim());
  } catch {}
  if (holder && alive(holder)) return false;

  // The holder is gone (it crashed mid-section). Move the stale lock aside — because
  // link() cannot overwrite, the file still sitting there proves no live process has
  // taken it, so this only ever displaces the dead holder. rename is atomic, so two
  // reclaimers cannot both win; the loser's rename throws and it simply retries.
  try {
    const aside = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
    renameSync(lockPath, aside);
    unlinkSync(aside);
  } catch {}
  return false;
}

const release = (lockPath) => {
  try {
    unlinkSync(lockPath);
  } catch {}
};

/** Run `critical` while holding the lock at `lockPath` (async). Throws only if the
 * lock cannot be taken within the retry budget — sustained contention with a live
 * holder, never a crash (which is reclaimed). */
export async function withLock(lockPath, critical, { tries = 200, waitMs = 20 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let i = 0; i < tries; i++) {
    if (tryAcquire(lockPath)) {
      try {
        return await critical();
      } finally {
        release(lockPath);
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`could not acquire lock: ${lockPath}`);
}

/** The synchronous twin, for a caller whose public API is synchronous (e.g. a
 * credential save). Contention is rare and brief; it blocks the thread with
 * Atomics.wait rather than a busy loop, so it does not spin the CPU while waiting. */
export function withLockSync(lockPath, critical, { tries = 200, waitMs = 20 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < tries; i++) {
    if (tryAcquire(lockPath)) {
      try {
        return critical();
      } finally {
        release(lockPath);
      }
    }
    Atomics.wait(idle, 0, 0, waitMs); // no waiter will ever notify; this is a plain sleep
  }
  throw new Error(`could not acquire lock: ${lockPath}`);
}
