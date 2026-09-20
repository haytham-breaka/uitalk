// Proving a pid is still the process we launched, before we kill it.
//
// A pidfile that stores only a number is not enough: if the machine crashes and
// leaves the file behind, the OS eventually reuses that pid for an unrelated
// process, and a later `uitalk --stop` would kill it. So the pidfile also records a
// per-instance start token — the process's creation time, which the OS assigns and
// which a reused pid will not share. Before killing, we recompute the token for the
// live pid and require it to match what we recorded at launch.
//
// The token is obtained without native modules or Linux-only paths: `ps -o lstart=`
// on any POSIX system (Linux, macOS, BSD), and CIM/WMI CreationDate on Windows. If a
// platform yields nothing, the token is null and ownership falls back to plain pid
// existence (the old best-effort behaviour) rather than refusing to stop at all.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stable per-instance fingerprint of the running process `pid`: its OS-assigned
 * start time. Returns null when this platform cannot supply one. */
export function startToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      // CreationDate is a WMI datetime, unique per process instance.
      const out = execFileSync(
        "cmd", ["/c", `wmic process where ProcessId=${pid} get CreationDate /value`],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 },
      ).toString();
      const m = out.match(/CreationDate=(\d+)/);
      return m ? m[1] : null;
    }
    // lstart is the process start time to the second — stable for a given process,
    // and different for a pid the OS has recycled into a new one.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Serialize the ownership record for a freshly launched process into a pidfile. */
export function writeOwner(path, pid) {
  writeFileSync(path, JSON.stringify({ pid, token: startToken(pid), startedAt: new Date().toISOString() }));
}

/** Parse a pidfile. Accepts a legacy bare-number file (token unknown) so an
 * existing install keeps working after an upgrade. */
export function readOwner(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (/^\d+$/.test(raw)) return { pid: Number(raw), token: null }; // pre-ownership pidfile
  try {
    const rec = JSON.parse(raw);
    return rec && Number.isInteger(rec.pid) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Do we still own the process this record describes?
 *   - not alive              -> false (nothing to own or kill)
 *   - alive, token unknown   -> true  (legacy record / platform can't fingerprint:
 *                                      best-effort, same as before ownership existed)
 *   - alive, token recorded  -> true only if the live process's token still matches;
 *                                a mismatch (or an unreadable token now) means the pid
 *                                was reused, so we refuse to claim it.
 */
export function owns(rec) {
  if (!rec || !alive(rec.pid)) return false;
  if (rec.token == null) return true;
  return startToken(rec.pid) === rec.token;
}
