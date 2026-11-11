// The in-page client, as one script, with the build stamp that names it.
//
// Two things ship this same script: the bridge, which serves it to the pages it
// proxies, and the browser extension, which carries a copy into deployed sites. A
// page reports the build it loaded, so both must compute that stamp the same way —
// from the same files in the same order — or every extension page would read as
// stale against the bridge that wrote it.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const CLIENT_FILES = ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]
  .map((f) => join(here, "..", "client", f));

/** A cheap change key: the files' mtimes. Equal keys mean the bundle is unchanged. */
export const clientKey = () =>
  CLIENT_FILES.map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join(":");

/** The concatenated client source and its 8-hex build stamp. */
export function bundleClient() {
  const source = CLIENT_FILES.map((f) => readFileSync(f, "utf8")).join("\n;\n");
  const build = createHash("sha1").update(source).digest("hex").slice(0, 8);
  return { source, build };
}
