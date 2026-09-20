// Deciding which local port a `--dev` server came up on.
//
// The launcher scans a list of common dev-server ports (5173, 3000, …). An open
// port there proves only that SOMETHING is listening — it may be an entirely
// unrelated project's dev server on a shared default port. So when `--dev` launches
// a command, the port to attach to is one that became open BECAUSE of that launch,
// never one that was already busy before it. These two helpers make that testable
// without real sockets: `isOpen` is injected.

/** The candidate ports currently listening, in candidate order — a snapshot taken
 * before launch so an already-running server can be told apart from ours. */
export async function openPorts(candidates, isOpen) {
  const open = [];
  for (const c of candidates) if (await isOpen(c)) open.push(c);
  return open;
}

/** The first candidate that is open now but was NOT in `preexisting` — i.e. the
 * server we just started, never a port that was already busy when we launched.
 * Returns null while nothing new has come up yet (keep waiting), rather than
 * falsely attaching to an unrelated server. */
export async function newlyOpenPort(candidates, isOpen, preexisting) {
  const skip = new Set(preexisting);
  for (const c of candidates) if (!skip.has(c) && (await isOpen(c))) return c;
  return null;
}
