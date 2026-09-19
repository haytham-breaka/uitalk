// A per-project capability token, so only a client the bridge actually handed the
// token to can open the control socket.
//
// Binding to loopback keeps other machines out, and the Origin check keeps a
// remote web page out, but neither stops another app on the same machine — a
// second dev server on localhost:3000, or a site the user is visiting — from
// opening a socket to this bridge and driving it. The token is the thing those
// cannot obtain: it is injected into the pages this bridge serves (never into the
// shared client.js bundle, which anyone can load cross-origin), and required on
// the socket handshake.
//
// It lives in the uitalk home, readable only by its owner, and never in the
// project — a token committed to a repo would defeat the point. Persisting it per
// project keeps a bookmarklet and an already-open page working across a bridge
// restart rather than silently failing to reconnect.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const FILE = join(HOME, "tokens.json");

/** The one spelling of a project two paths to the same directory agree on, so a
 * bridge and an MCP server started with different spellings still share a token. */
function key(project) {
  let p;
  try {
    p = realpathSync.native ? realpathSync.native(project) : realpathSync(project);
  } catch {
    p = project;
  }
  return process.platform === "win32" ? p.toLowerCase() : p;
}

const read = () => {
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** This project's token, created on first use and reused after. */
export function projectToken(project) {
  const k = key(project);
  const store = read();
  if (typeof store[k] === "string" && store[k]) return store[k];

  const token = randomBytes(24).toString("hex");
  mkdirSync(HOME, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...store, [k]: token }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, FILE);
  try {
    chmodSync(FILE, 0o600);
  } catch {}
  return token;
}
