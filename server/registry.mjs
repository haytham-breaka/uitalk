// A registry of running bridges, so several can coexist and be found.
//
// One bridge serves one app. Running four of them against four projects from four
// terminals is the normal case, not an edge case, so nothing here may assume a
// fixed port or a single instance.
//
// Each bridge owns one file, <home>/instances/<pid>.json, written temp-and-rename
// so a reader never sees a partial one. A single shared file would need a
// read-modify-write that two bridges starting at once can lose an update through
// (both read [], each writes its own single-element array, the second wins); one
// file per process removes that shared state entirely.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startToken, owns } from "./proc-identity.mjs";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const DIR = join(HOME, "instances");
const LEGACY = join(HOME, "instances.json"); // the pre-per-pid single-file registry

const entryFile = (pid) => join(DIR, `${pid}.json`);

const validEntry = (e) => Boolean(e) && typeof e === "object" && typeof e.pid === "number";

// Is the process that wrote this entry still the one running under that pid? Bare
// pid existence is not enough: a crashed bridge whose pid the OS later reuses for an
// unrelated process would otherwise read as "still running" forever, and block a
// legitimate replacement bridge from being found. So an entry records the bridge's
// process-instance token (see proc-identity) and is only live when that token still
// matches. A pre-token entry (older build) has none, so it falls back to pid
// existence — owns() treats a null token as legacy exactly this way. When identity
// cannot be confirmed the entry is dropped, which is the safe direction here: a stale
// record is cleared so a replacement can register, never kept to wedge one out.
const stillRunning = (e) => owns({ pid: e.pid, token: e.token, legacy: e.token == null });

/** Drop the instances directory when it holds nothing, so "nothing running"
 * leaves nothing behind — rmdir throws (harmlessly) while it still has files. */
function pruneEmptyDir() {
  try {
    rmdirSync(DIR);
  } catch {}
}

/** The old single-file registry, if one is still around to migrate. */
function readLegacy() {
  try {
    const list = JSON.parse(readFileSync(LEGACY, "utf8"));
    return Array.isArray(list) ? list.filter(validEntry) : [];
  } catch {
    return [];
  }
}

export function add(entry) {
  mkdirSync(DIR, { recursive: true });
  // Stamp the process-instance token so a later reader can tell this bridge from an
  // unrelated process that inherits its pid after a crash. Keep any token already on
  // the entry (a legacy record migrated forward is left as-is rather than restamped).
  const full = {
    ...entry,
    token: entry.token ?? startToken(entry.pid),
    startedAt: entry.startedAt ?? new Date().toISOString(),
  };
  const file = entryFile(entry.pid);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2));
  renameSync(tmp, file); // atomic replace of only this pid's entry
}

export function remove(pid = process.pid) {
  try {
    unlinkSync(entryFile(pid));
  } catch {}
  pruneEmptyDir();
}

/** Registered instances whose process is still running; prunes the dead ones,
 * ignores anything malformed, and folds in a legacy single-file registry once. */
export function list() {
  const live = new Map(); // pid -> entry

  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {} // no directory yet: nothing registered here

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(DIR, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      entry = null;
    }
    if (!validEntry(entry) || !stillRunning(entry)) {
      try {
        unlinkSync(file); // malformed, dead, or a reused pid — prune it
      } catch {}
      continue;
    }
    live.set(entry.pid, entry);
  }

  // A registry written by an older build still points at bridges that may be
  // running. Migrate the live ones forward to per-pid files, then retire the
  // legacy file so this only happens once.
  const legacy = readLegacy();
  if (legacy.length) {
    for (const entry of legacy) {
      if (stillRunning(entry) && !live.has(entry.pid)) {
        live.set(entry.pid, entry);
        try {
          add(entry);
        } catch {}
      }
    }
    try {
      unlinkSync(LEGACY);
    } catch {}
  }

  pruneEmptyDir();
  return [...live.values()];
}

/** Another instance already fronting this app is almost always a duplicate. */
export const servingApp = (appHost, appPort) =>
  list().find((e) => e.appPort === appPort && e.appHost === appHost);

// The directory the per-instance files live in (was a single JSON file before).
export const registryPath = DIR;
