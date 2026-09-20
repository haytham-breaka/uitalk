// A cross-process mutex around "is a bridge already serving this project? if not,
// register myself as the one that does."
//
// Two launchers started for the same project at the same moment can both look at the
// registry, both see nothing, and both spawn a bridge — leaving two bridges (two
// ports, two agent sessions) fronting one project, with a later lookup finding only
// one of them. The check and the registration have to be one indivisible step, and
// across processes that needs a lock the OS enforces, not a plain check-then-write.
//
// The lock is a create-exclusive file: openSync(path, "wx") is atomic, so exactly
// one starter creates it and the rest get EEXIST. It is held only for the brief
// critical section — check the registry, register if clear — and always released, so
// it never lingers as long-lived state that could go stale. The one way it can be
// left behind is a process that crashed *inside* the section; the next starter finds
// the holder's pid dead and reclaims it, so a crash can never wedge startup forever.

import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./project-id.mjs";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const LOCK_DIR = join(HOME, "locks");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `critical` while holding this project's startup lock. Returns whatever
 * `critical` returns. Throws only if the lock cannot be acquired within the retry
 * budget (sustained contention with a live holder — never a crash, which is
 * reclaimed). The critical section is expected to be short and synchronous.
 */
export async function withProjectLock(project, critical) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = join(LOCK_DIR, `${projectSlug(project)}.lock`);

  for (let attempt = 0; attempt < 100; attempt++) {
    let fd;
    try {
      fd = openSync(lockPath, "wx"); // atomic create-if-absent — only one starter wins
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Someone holds it. If the holder's process is gone (it crashed mid-section),
      // reclaim the lock and retry at once; otherwise it is genuinely busy — wait.
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
      } catch {} // being written right now, or already removed — treat as reclaimable
      if (!holder || !alive(holder)) {
        try {
          unlinkSync(lockPath);
        } catch {} // another reclaimer won the race; the next openSync sorts it out
        continue;
      }
      await wait(20);
      continue;
    }
    try {
      writeSync(fd, String(process.pid)); // whose it is, so a stale one can be judged
      closeSync(fd);
      return await critical(); // await, so an async section finishes before we release
    } finally {
      try {
        unlinkSync(lockPath); // release: the section is over (or threw) — never held on
      } catch {}
    }
  }
  throw new Error("could not acquire the project startup lock");
}
