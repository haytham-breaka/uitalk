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

// Windows: read the process creation time via PowerShell + CIM. WMIC, which the old
// implementation shelled out to, is removed from current Windows 11, so a wmic call
// returns nothing there and the token silently goes null — reintroducing the pid-reuse
// hole. Get-CimInstance ships with Windows PowerShell 5.1 (present on every supported
// Windows). ToFileTimeUtc() renders the creation time as a stable 64-bit integer,
// unique to this process instance. WMIC is kept only as a fallback for the rare older
// host that still has it but lacks a usable PowerShell.
function winStartToken(pid) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($p) { $p.CreationDate.ToFileTimeUtc() }`],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).toString().trim();
    if (out) return out;
  } catch {}
  try {
    const out = execFileSync("cmd", ["/c", `wmic process where ProcessId=${pid} get CreationDate /value`], {
      stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).toString();
    const m = out.match(/CreationDate=(\d+)/);
    if (m) return m[1];
  } catch {}
  return null;
}

/** A stable per-instance fingerprint of the running process `pid`: its OS-assigned
 * start time. Returns null when this platform cannot supply one. */
export function startToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return winStartToken(pid);
  try {
    // lstart is the process start time to the second — stable for a given process,
    // and different for a pid the OS has recycled into a new one. `ps` is on every
    // POSIX system (Linux, macOS, BSD).
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

/** Parse a pidfile. A legacy bare-number file (written before ownership existed) is
 * marked `legacy` so it keeps its old best-effort behaviour; a new-format JSON record
 * is not, so an absent/unverifiable identity there is treated as fail-safe. */
export function readOwner(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (/^\d+$/.test(raw)) return { pid: Number(raw), token: null, legacy: true }; // pre-ownership pidfile
  try {
    const rec = JSON.parse(raw);
    return rec && Number.isInteger(rec.pid) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Do we still own the process this record describes?
 *   - not alive                    -> false (nothing to own or kill)
 *   - legacy bare-pid, alive        -> true  (best-effort pid existence, as before
 *                                             ownership existed — the only compat path)
 *   - new-format, token missing     -> FALSE. We meant to record a strong identity and
 *                                      could not (e.g. a Windows without a usable
 *                                      PowerShell), so ownership is unproven: fail safe
 *                                      and do NOT authorize killing a live process.
 *   - new-format, token recorded    -> true only if the live process's token still
 *                                      matches; a mismatch (a reused pid) or an
 *                                      unreadable token now means it is not ours.
 */
export function owns(rec) {
  if (!rec || !alive(rec.pid)) return false;
  if (rec.legacy) return true;
  if (rec.token == null) return false;
  return startToken(rec.pid) === rec.token;
}
