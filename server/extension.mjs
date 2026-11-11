// Installs the uitalk browser extension into a folder Chrome can load, and keeps it
// current.
//
// The extension carries its own copy of the client: Manifest V3 forbids running code
// fetched at runtime, so it cannot load client.js from the bridge the way a proxied
// page does. That copy goes stale whenever the client changes, so every folder the
// extension was installed into is remembered and rewritten when a bridge starts or
// its client changes. The extension reloads itself when the bridge reports a build it
// does not have (see extension/background.js), which picks the rewritten files up —
// the user loads the folder once and never rebuilds by hand.
//
// The folder is outside the repo and outside the plugin cache on purpose: a plugin
// update replaces the cache directory, and an unpacked extension pointed at a path
// that no longer exists simply disappears from Chrome.

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleClient } from "./client-bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "extension");
const home = () => process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const listFile = () => join(home(), "extension.json");

export const defaultExtensionDir = () => join(home(), "extension");

const MANIFEST_NAME = "uitalk";
const BUILD_LINE = /^globalThis\.__UITALK_BUILD__ = "([0-9a-f]{8})";$/m;

function writeAtomic(path, body) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

/** The build the copy in `dir` carries, or null when there is none. */
export function installedBuild(dir) {
  try {
    return BUILD_LINE.exec(readFileSync(join(dir, "client.js"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Only write into a folder that is empty, missing, or already a uitalk extension.
 * Pointed at the wrong folder by a typo, this would otherwise scatter files into
 * someone's project or home directory.
 */
function safeTarget(dir) {
  if (!existsSync(dir)) return { ok: true };
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return { ok: false, error: `cannot read ${dir}: ${err.message}` };
  }
  if (!entries.length) return { ok: true };
  try {
    if (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).name === MANIFEST_NAME) return { ok: true };
  } catch {}
  return { ok: false, error: `${dir} is not empty and is not a uitalk extension folder; choose an empty one` };
}

/** Write the extension into `dir` and remember it for later refreshes. */
export function installExtension(dir = defaultExtensionDir()) {
  dir = resolve(dir);
  const target = safeTarget(dir);
  if (!target.ok) return target;
  mkdirSync(dir, { recursive: true });

  for (const name of readdirSync(SOURCE)) {
    let body = readFileSync(join(SOURCE, name));
    if (name === "manifest.json") {
      const manifest = JSON.parse(body.toString("utf8"));
      manifest.version = packageVersion();
      body = JSON.stringify(manifest, null, 2);
    }
    writeAtomic(join(dir, name), body);
  }

  const { source, build } = bundleClient();
  // The same stamp line the bridge's own prelude writes, so a page can compare the
  // two. No token: the extension's socket is opened by its service worker, which
  // holds the token, and the page side never sees it.
  const prelude =
    `globalThis.__UITALK_BUILD__ = ${JSON.stringify(build)};\n` +
    `globalThis.__UITALK_TOKEN__ = null;\n`;
  writeAtomic(join(dir, "client.js"), `${prelude}${source}`);

  remember(dir);
  return { ok: true, dir, build };
}

function remembered() {
  try {
    const v = JSON.parse(readFileSync(listFile(), "utf8"));
    return Array.isArray(v?.dirs) ? v.dirs.filter((d) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/** Every remembered install still on disk that holds a client. */
export function installedDirs() {
  return remembered().filter((d) => installedBuild(d));
}

function remember(dir) {
  const dirs = remembered();
  if (dirs.includes(dir)) return;
  mkdirSync(home(), { recursive: true });
  writeAtomic(listFile(), JSON.stringify({ dirs: [...dirs, dir] }, null, 2));
}

/**
 * Rewrite every remembered install whose client is not `build`. Returns what it
 * did, so the caller can log it; never throws — a folder the user deleted is
 * simply skipped.
 */
export function refreshExtensions(build = bundleClient().build) {
  const out = [];
  for (const dir of remembered()) {
    if (!existsSync(dir)) continue;
    if (installedBuild(dir) === build) continue;
    try {
      const r = installExtension(dir);
      out.push(r.ok ? { dir, build: r.build } : { dir, error: r.error });
    } catch (err) {
      out.push({ dir, error: err.message });
    }
  }
  return out;
}
