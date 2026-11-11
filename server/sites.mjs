// The deployed sites a project's bridge may be paired with, through the extension.
//
// A deployed site is not served by the bridge, so the bridge cannot inject the
// panel into it the way it does a local app. The uitalk browser extension does
// that instead, and it has to learn which bridge a site belongs to. It learns it
// from a pairing page the bridge serves — and that page must only ever offer a
// site the user asked for from their own terminal (`uitalk --url <site>`).
// Otherwise any web page could open http://127.0.0.1:8400/__uitalk/pair?site=evil
// in a tab and ask the user to wire their bridge to a site of its choosing.
//
// So the list lives here, written only by the launcher, keyed by project the same
// way the launcher's other per-project files are, and read fresh on every request so
// `uitalk --url` adds a site to an already-running bridge without a restart.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./project-id.mjs";

const home = () => process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const fileFor = (project) => join(home(), "sites", `${projectSlug(project)}.json`);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The origin a site URL names, or an error. Only http(s) is a site: a pairing grants
 * the extension a host permission for exactly this origin, so anything else
 * (file:, chrome:, data:) has no meaning here. Plain http is only accepted for
 * loopback and private-network hosts — a staging site reached over plain http on
 * the open internet would put the session's page content on the wire unencrypted.
 */
export function normalizeSite(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: `only http and https sites can be paired (got ${url.protocol})` };
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return { ok: false, error: `use https for ${url.hostname}: plain http is only accepted for local and private-network hosts` };
  }
  return { ok: true, origin: url.origin };
}

function isPrivateHost(hostname) {
  if (LOOPBACK.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** The origins recorded for this project, oldest first. */
export function sitesFor(project) {
  try {
    const v = JSON.parse(readFileSync(fileFor(project), "utf8"));
    return Array.isArray(v?.sites) ? v.sites.filter((s) => normalizeSite(s).ok) : [];
  } catch {
    return [];
  }
}

/** Record a site for this project; returns its origin, or an error. Idempotent. */
export function addSite(project, raw) {
  const site = normalizeSite(raw);
  if (!site.ok) return site;
  const sites = sitesFor(project);
  if (!sites.includes(site.origin)) {
    sites.push(site.origin);
    const file = fileFor(project);
    mkdirSync(join(home(), "sites"), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ project, sites }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
  return site;
}

export const isSiteFor = (project, origin) => sitesFor(project).includes(origin);
