// A registry of running bridges, so several can coexist and be found.
//
// One bridge serves one app. Running four of them against four projects from four
// terminals is the normal case, not an edge case, so nothing here may assume a
// fixed port or a single instance.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const FILE = join(DIR, "instances.json");

const alive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching the process
    return true;
  } catch {
    return false;
  }
};

function read() {
  try {
    const list = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Temp-and-rename so a reader never sees a half-written file. An empty registry
// is represented by no file at all, so "nothing running" leaves nothing behind.
function write(list) {
  if (!list.length) {
    try {
      unlinkSync(FILE);
    } catch {}
    return;
  }
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, FILE);
}

/** Registered instances whose process is still running; prunes the dead ones. */
export function list() {
  const live = read().filter((e) => alive(e.pid));
  if (live.length !== read().length) write(live);
  return live;
}

export function add(entry) {
  write([...list().filter((e) => e.pid !== entry.pid), { ...entry, startedAt: new Date().toISOString() }]);
}

export function remove(pid = process.pid) {
  write(list().filter((e) => e.pid !== pid));
}

/** Another instance already fronting this app is almost always a duplicate. */
export const servingApp = (appHost, appPort) =>
  list().find((e) => e.appPort === appPort && e.appHost === appHost);

export const registryPath = FILE;
