// uitalk server.
//
// Holds one long-lived agent session whose input is a push-driven async
// generator: a message from the page resolves a parked promise and reaches the
// agent immediately. Nothing polls. The same socket carries request/response
// calls in the other direction, so the agent's tools can read and preview
// against the live page.
//
// Three things can be on the other end of that session, chosen by the `agent`
// setting. `builtin` is Claude Code on the user's own subscription. `adapter` is
// any model they hold a key for, driven over its HTTP API (./adapter.mjs).
// `off` is nobody: the page tools are driven by an MCP client instead
// (./mcp.mjs), so the panel's chat and context controls stand aside rather than
// pretending to work. Everything below that is not the session itself — the
// proxy, the tools, selection, capture, undo — is the same in all three.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { createAdapter, normalize } from "./adapter.mjs";
import { createProxy, proxyUpgrade } from "./proxy.mjs";
import * as registry from "./registry.mjs";
import * as settings from "./settings.mjs";
import * as snapshots from "./snapshots.mjs";
import { countUsages } from "./usage.mjs";
import { findSourceCandidates } from "./candidates.mjs";

// A fixed port would stop the second bridge from ever starting. An explicit
// UITALK_PORT is honoured exactly; otherwise the first free port from 8400 wins.
const FIXED_PORT = process.env.UITALK_PORT ? Number(process.env.UITALK_PORT) : null;
const PORT_RANGE = Array.from({ length: 40 }, (_, i) => 8400 + i);
let port = FIXED_PORT ?? PORT_RANGE[0];
const PROJECT = process.env.UITALK_PROJECT ?? process.cwd();
const RPC_TIMEOUT = Number(process.env.UITALK_RPC_TIMEOUT ?? 5000);
const APP_HOST = process.env.UITALK_APP_HOST ?? "127.0.0.1";
const APP_PORT = Number(process.env.UITALK_APP_PORT ?? 5173);
const SOCKET_PATH = "/__uitalk/socket";

const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(`[uitalk]`, ...a);

let config = settings.load(PROJECT);

// The injected client, served as one file so the page needs a single tag.
//
// It is read from disk when it has changed rather than once at startup: otherwise a
// long-running bridge keeps serving the bundle it booted with, so updating the
// plugin — or editing the client — would appear to do nothing until someone thought
// to restart the bridge. The build stamp travels with it so a page that loaded an
// older one says so instead of looking like a live bug.
const CLIENT_FILES = ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]
  .map((f) => join(here, "..", "client", f));
const SERVER_FILES = ["index.mjs", "page-tools.mjs", "tool-defs.mjs", "proxy.mjs",
                      "settings.mjs", "registry.mjs", "snapshots.mjs"]
  .map((f) => join(here, f));

const stamp = (files) =>
  files.map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join(":");

let clientCache = { key: "", body: "", build: "" };

function readClient() {
  const key = stamp(CLIENT_FILES);
  if (key === clientCache.key) return clientCache;
  const source = CLIENT_FILES.map((f) => readFileSync(f, "utf8")).join("\n;\n");
  const build = createHash("sha1").update(source).digest("hex").slice(0, 8);
  if (clientCache.build && clientCache.build !== build) {
    log(`client rebuilt: ${clientCache.build} -> ${build} (reload any open page)`);
    toPanel({ kind: "client_updated", build });
  }
  clientCache = { key, body: `globalThis.__UITALK_BUILD__ = ${JSON.stringify(build)};\n${source}`, build };
  return clientCache;
}

// The bridge's own code cannot be swapped under a running process, so changes to it
// are reported rather than applied — silently serving old behaviour is how an
// already-fixed bug gets chased twice.
const SERVER_STAMP = stamp(SERVER_FILES);

function checkServerFreshness() {
  if (stamp(SERVER_FILES) === SERVER_STAMP) return;
  log("the bridge's own code has changed on disk — restart it to pick that up");
  toPanel({ kind: "bridge_stale" });
}

// ---------------------------------------------------------------- transport

// The last HTML served per path, so an element can be located even when the page
// carries no framework metadata. Capped: this is a lookup aid, not a cache.
const servedHtml = new Map();

const appProxy = createProxy({
  target: { host: APP_HOST, port: APP_PORT },
  onHtml: (url, html) => {
    const path = url.split("?")[0];
    servedHtml.set(path, html);
    while (servedHtml.size > 12) servedHtml.delete(servedHtml.keys().next().value);
  },
});

/** How many other project files render a resolved component — see usage.mjs. */
function countComponentUsages(name, definingFile) {
  return countUsages(PROJECT, name, definingFile);
}

/** Project-source candidates for locate_source when no framework metadata answered. */
function findProjectCandidates(needles) {
  return findSourceCandidates(PROJECT, needles);
}

/** Find a needle in the HTML we served for a path, reporting line and column. */
function findInServedHtml(path, needles) {
  const html = servedHtml.get(path) ?? servedHtml.get(path.replace(/\/$/, "")) ?? null;
  if (!html) return { found: false, reason: `nothing served for ${path} yet` };

  const lines = html.split("\n");
  for (const needle of needles.filter(Boolean)) {
    for (const [i, line] of lines.entries()) {
      const col = line.indexOf(needle);
      if (col !== -1) {
        return {
          found: true,
          line: i + 1,
          column: col + 1,
          matched: needle,
          excerpt: lines[i].trim().slice(0, 160),
        };
      }
    }
  }
  return { found: false, reason: `none of ${needles.length} identifiers appear in the served HTML` };
}

const http = createServer((req, res) => {
  // "The panel is not showing" is usually a request that never arrived: the tab is on
  // the dev server's own port, or a cached HTML response carries no script tag. Seeing
  // the requests settles it in one reload.
  if (process.env.UITALK_DEBUG) log(`${req.method} ${req.url}`);

  if (req.url === "/__uitalk/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true, pid: process.pid, port, clients: clients.size,
        project: PROJECT, app: `${APP_HOST}:${APP_PORT}`, build: readClient().build,
      }),
    );
    return;
  }
  if (req.url === "/__uitalk/client.js") {
    const { body } = readClient();
    checkServerFreshness();
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  // The split-screen shell: the app in a resizable frame, the panel beside it.
  if (req.url === "/__uitalk/shell" || req.url.startsWith("/__uitalk/shell#")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><html data-uitalk-shell="1"><head><meta charset="utf-8">` +
        `<title>uitalk</title></head><body>` +
        `<script>window.__UITALK_SHELL__ = true;</script>` +
        `<script src="/__uitalk/client.js"></script>` +
        `</body></html>`,
    );
    return;
  }

  if (req.url === "/__uitalk/bookmarklet") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `javascript:(function(){var s=document.createElement('script');` +
        `s.src='http://127.0.0.1:${PORT}/__uitalk/client.js';document.documentElement.appendChild(s);})()`,
    );
    return;
  }
  appProxy(req, res);
});

// Our socket is claimed by path; everything else upgrading (HMR) is piped to the app.
const wss = new WebSocketServer({ noServer: true });
const forwardUpgrade = proxyUpgrade({ target: { host: APP_HOST, port: APP_PORT } });

// A browser can be made to open a WebSocket to any local port just by visiting a
// page that tries it — binding to loopback keeps other machines out, but not a
// malicious page running in the user's own browser. Origin is the standard defense:
// it is set by the browser itself and cannot be spoofed by page script. Non-browser
// clients (the MCP server, a plain Node `ws` connection) never send one at all, so
// only a *present and untrue* origin is refused. The bridge and the app it proxies
// are only ever reached on loopback (see http.listen below and APP_HOST's default),
// so every legitimate caller — the proxied app, the split-screen shell, and the
// bookmarklet pointed at a locally-run dev server — has a loopback origin too.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function originIsTrusted(originHeader) {
  if (!originHeader) return true;
  let hostname;
  try {
    hostname = new URL(originHeader).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

http.on("upgrade", (req, socket, head) => {
  if (req.url === SOCKET_PATH) {
    if (!originIsTrusted(req.headers.origin)) {
      log(`rejected a socket upgrade from an untrusted origin: ${req.headers.origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  forwardUpgrade(req, socket, head);
});

const clients = new Set();

function toPanel(frame) {
  const json = JSON.stringify(frame);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}

// ------------------------------------------------------- page RPC (out-bound)

let rpcSeq = 0;
const pending = new Map();

// Several tabs can be pointed at the bridge at once. Sending to whichever socket
// happened to be first sent requests to a background tab, where rAF is paused and
// the selection is somebody else's — so route to the page the user last used.
let activePage = null;

// Not every socket is a page. A standalone MCP server connects here too, on behalf
// of an editor that is not Claude Code; it must never be mistaken for a page to send
// requests to, and it needs to hear about approvals a page cannot push to it.
const agents = new Set();

function markActive(ws) {
  if (!agents.has(ws)) activePage = ws;
}

function currentPage() {
  if (activePage && activePage.readyState === activePage.OPEN && !agents.has(activePage)) return activePage;
  const open = [...clients].filter((ws) => ws.readyState === ws.OPEN && !agents.has(ws));
  return open.at(-1) ?? null; // most recently connected
}

const toAgents = (frame) => {
  const json = JSON.stringify(frame);
  for (const ws of agents) if (ws.readyState === ws.OPEN) ws.send(json);
};

function callPage(method, params = {}, timeoutMs = RPC_TIMEOUT) {
  const page = currentPage();
  if (!page) return Promise.reject(new Error("no page is connected"));

  const id = ++rpcSeq;
  page.send(JSON.stringify({ kind: "rpc", id, method, params }));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, page, method });
  });
}

// A result only settles the request if it comes back on the same socket the
// request was sent to — otherwise a second connected page could answer on behalf
// of the one actually asked, e.g. with a fabricated selection or capture.
function settleRpc({ id, result, error }, ws) {
  const entry = pending.get(id);
  if (!entry || entry.page !== ws) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (error) entry.reject(new Error(error));
  else entry.resolve(result);
}

/** A page that disconnects mid-call leaves nothing to ever answer it — reject those
 * calls right away instead of leaving the caller to wait out the generic timeout. */
function rejectPending(page) {
  for (const [id, entry] of pending) {
    if (entry.page !== page) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(`${entry.method}: the page disconnected before answering`));
  }
}

// ------------------------------------------------- agent inbox (in-bound push)

// Set once the session starts. The panel's chat, compaction and New-session
// controls all go through this, so they behave the same whichever mode is running
// and report honestly when the answer is "nobody is listening".
let session = null;

/** The three run* functions construct this themselves in production; a test stands
 * in for one to exercise compact()/clearSession() without a real SDK. */
function setSessionForTest(s) {
  session = s;
}

// Indirection so a test can force a controllable delay around the approval
// snapshot without touching the git-backed implementation itself.
let snapshotFn = (label) => snapshots.snapshot(PROJECT, label);
function setSnapshotForTest(fn) {
  snapshotFn = fn ?? ((label) => snapshots.snapshot(PROJECT, label));
}

/** captureAfter() sends no panel frame of its own, so a test polls this instead
 * of sleeping for a duration a slower machine may not honour. */
function approvalPhaseForTest() {
  return approvalPhase;
}

const AGENT_MODES = {
  builtin: "the built-in Claude session",
  adapter: "your own model",
  opencode: "an OpenCode session",
  off: "an MCP client",
};

let wake = null;
const backlog = [];

// Builtin mode feeds one long-lived query() call through a single async
// generator, so exactly one prompt is in flight at a time — but nothing
// stopped an internal ask (compaction's summary request, "/clear") from being
// pushed while an ordinary turn was still running. Since only one "result"
// event can be waited on at once (see `internal` below), that made the
// ordinary turn's own completion get mistaken for the internal ask's answer,
// dropping its transcript entry, its turn_end, and its undo-safety capture
// entirely. Tracking whether a turn is currently open lets askAgent() wait its
// turn instead, the same way adapter and opencode already serialize their own
// summarize()/clear() behind send() with a promise-chain queue.
let builtinTurnOpen = false;
const afterBuiltinTurn = [];

function pushToAgent(content) {
  // Both drive their own HTTP-shaped conversation rather than the Claude SDK's
  // async-generator inbox below, so they own the send path themselves.
  if (session?.mode === "adapter" || session?.mode === "opencode") return session.send(content);
  if (config.agent === "off") {
    // Nothing can be pushed to an MCP client, and silently swallowing the message
    // would look like an agent that never answers.
    toPanel({
      kind: "agent_absent",
      text:
        "uitalk is running without a built-in agent, so there is nobody here to read that. " +
        "Ask in the editor that is connected over MCP — it has the page tools.",
    });
    return;
  }
  builtinTurnOpen = true;
  const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  if (wake) {
    const resume = wake;
    wake = null;
    resume(msg);
  } else {
    backlog.push(msg);
  }
}

async function* inbox() {
  for (;;) {
    if (backlog.length) {
      yield backlog.shift();
      continue;
    }
    yield await new Promise((resolve) => {
      wake = resolve;
    });
  }
}

// --------------------------------------------------------------- frame router

wss.on("connection", (ws) => {
  clients.add(ws);
  log(`page connected (${clients.size} open)`);
  ws.send(
    JSON.stringify({
      kind: "ready",
      project: PROJECT,
      port,
      build: readClient().build,
      settings: config,
      fields: settings.FIELDS,
      agent: { mode: config.agent, label: session?.label ?? null, of: AGENT_MODES[config.agent] },
      context: { tokens: context.tokens, percent: context.percent, limit: config.contextTokens },
    }),
  );
  if (transcript.length) ws.send(JSON.stringify({ kind: "replay", entries: transcript }));

  ws.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return log("dropped a frame that was not JSON");
    }

    switch (frame.kind) {
      case "rpc_result":
        return settleRpc(frame, ws);

      case "hello":
      case "focus": {
        if (frame.role === "agent") {
          agents.add(ws);
          log(`an external agent attached (${agents.size} connected)`);
          return;
        }
        // Only these two kinds are genuine "I am the tab the user is looking at"
        // signals — see client/ui.js's announce(), sent on connect, on becoming
        // visible, on window focus, and on a click inside the panel. Every other
        // frame kind is something a page sends once it is already the active one,
        // not evidence that a different, possibly stale or background, socket
        // deserves to become it.
        markActive(ws);
        const others = [...clients].filter((c) => c !== ws && c.readyState === c.OPEN).length;
        toPanel({ kind: "pages", total: others + 1, activeUrl: frame.url });
        return;
      }

      case "chat": {
        if (process.env.UITALK_DEBUG === "3") {
          const built = buildUserContent(frame);
          const shown = typeof built === "string"
            ? built
            : built.map((b) => (b.type === "image" ? `<image ${b.source.data.length} b64 chars>` : b.text)).join("\n");
          log(`--- what the agent receives ---\n${shown}\n--- end ---`);
        }
        const n = frame.shots?.length ?? (frame.png ? 1 : 0);
        const note = [
          n ? `${n} screenshot${n === 1 ? "" : "s"}` : null,
          frame.selectionCount ? `${frame.selectionCount} element(s) selected` : null,
        ].filter(Boolean).join(", ");
        record("me", note ? `${frame.text}\n[sent with ${note}]` : frame.text);
      }
        return pushToAgent(buildUserContent(frame));

      // The panel's answer to an ask_choice question: a plain reply, not an approval —
      // nothing here is committed to source, so it is forwarded like chat rather than
      // routed through the CSS-approval path. Still relayed to `agents` so a standalone
      // MCP client blocked in await_answer (which cannot be pushed a message) hears it.
      case "choice_answer":
        record("me", frame.label);
        toAgents(frame);
        return pushToAgent(frame.label);

      case "settings": {
        const { settings: next, written, rejected } = settings.save(PROJECT, frame.patch);
        config = next;
        log(`settings saved to ${written}${rejected.length ? ` (${rejected.join("; ")})` : ""}`);
        toPanel({ kind: "settings", settings: config, written, rejected });
        return;
      }

      case "revert": {
        // Blocks a new approval too (it requires "idle"): its snapshot() and this
        // revertTo() both rewrite the working tree, and running them concurrently
        // could interleave a stash-create with a checkout, or race each other.
        if (approvalPhase === "reverting") {
          toPanel({ kind: "reverted", ok: false, text: "already undoing the last change — wait for that to finish" });
          return;
        }
        void (async () => {
          if (!lastChange?.snap) {
            toPanel({ kind: "reverted", ok: false, text: "there is nothing to go back to" });
            return;
          }
          // postCaptured is only set once the turn that made this change has
          // genuinely finished (see noteTurnEnded()). Reverting before then would
          // race that turn's own writes with git checkout — safer to say so than
          // to interleave with a file the agent may still be in the middle of.
          if (!lastChange.snap.postCaptured) {
            toPanel({
              kind: "reverted",
              ok: false,
              text: "the agent hasn't finished making this change yet — wait for it to finish, then undo",
            });
            return;
          }
          approvalPhase = "reverting";
          try {
            const out = await snapshots.revertTo(PROJECT, lastChange.snap);
            log(
              `revert of "${lastChange.label}": restored ${out.reverted.length}, ` +
                `removed ${out.removed.length}, left ${out.skipped.length} alone (edited again since)`,
            );
            toPanel({
              kind: "reverted",
              ok: true,
              files: out.reverted,
              removed: out.removed,
              skipped: out.skipped,
              note: out.note,
              label: lastChange.label,
            });
            const summary =
              [
                out.reverted.length ? `restored: ${out.reverted.join(", ")}` : null,
                out.removed.length ? `removed: ${out.removed.join(", ")}` : null,
                out.skipped.length
                  ? `left alone because they were edited again since: ${out.skipped.join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(". ") || "nothing changed";
            notifyAgents(
              `The user reverted the last change ("${lastChange.label}"). ${summary}. ` +
                `Do not re-apply it unless asked.`,
            );
            pushToAgent(
              `I reverted the last change ("${lastChange.label}") in the working tree. ${summary}. ` +
                `Do not re-apply it unless I ask.`,
            );
            lastChange = null;
            approvalPhase = "idle";
          } catch (err) {
            approvalPhase = "idle";
            toPanel({ kind: "reverted", ok: false, text: err.message });
          }
        })();
        return;
      }

      // An external agent asks the bridge to put a question to the page, because it
      // has no socket of its own to the page and no way to be pushed to.
      case "call": {
        callPage(frame.method, frame.params, frame.timeout ?? RPC_TIMEOUT).then(
          (result) => ws.send(JSON.stringify({ kind: "call_result", id: frame.id, result })),
          (err) => ws.send(JSON.stringify({ kind: "call_result", id: frame.id, error: err.message })),
        );
        return;
      }

      case "compact_now":
        return void compact("requested from the panel");

      case "clear":
        return void clearSession();

      case "approval": {
        if (typeof frame.label !== "string" || !frame.label || typeof frame.declarations !== "string") {
          toPanel({ kind: "approval_rejected", label: frame.label, text: "that approval was missing its label or declarations" });
          return;
        }
        if (approvalPhase !== "idle") {
          toPanel({
            kind: "approval_rejected",
            label: frame.label,
            text: "still applying the previous approved change — approve this one again once it finishes",
          });
          return;
        }
        approvalPhase = "snapshotting";
        record("me", `approved: ${frame.label}`);
        // Neither the external-agent notice nor the edit instruction may reach an
        // agent until the pre-edit snapshot exists — otherwise the agent's own
        // write can land in what undo believes was the "before" state, and undo
        // would no longer fully restore it. See snapshots.mjs's snapshot(), a real
        // subprocess call, not something that resolves before this handler returns.
        void (async () => {
          const snap = await snapshotFn(frame.label);
          lastChange = { snap, label: frame.label };
          approvalPhase = "editing";
          toPanel({ kind: "revertable", available: Boolean(snap), label: frame.label });
          toAgents(frame); // an external agent cannot be sent a message; it waits for this
          pushToAgent(
            `The user approved option "${frame.label}" for element ${frame.ref}.\n\n` +
              `Approved declarations:\n${frame.declarations}\n` +
              (frame.also ? `Additional rules:\n${frame.also}\n` : "") +
              `\nElement identity:\n${JSON.stringify(frame.element, null, 2)}\n` +
              `Page: ${frame.page?.path ?? "unknown"}\n\n` +
              `Now commit this to source. Find where this element is defined and where its ` +
              `styles live, then make the edit the way the surrounding code would. Match the ` +
              `project's conventions rather than pasting the preview CSS verbatim, and do not ` +
              `carry over any data-uitalk-* attribute. Tell me which files you changed.`,
          );
        })();
        return;
      }

      default:
        log(`ignored frame of unknown kind: ${frame.kind}`);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    agents.delete(ws);
    if (activePage === ws) activePage = null;
    rejectPending(ws);
    log(`page disconnected (${clients.size} open)`);
  });
  ws.on("error", (err) => log("socket error:", err.message));
});

// A chat frame may carry a screenshot the user volunteered with their message.
function buildUserContent(frame) {
  const v = frame.page?.viewport;
  const screen = frame.page?.screen;
  // The simulated screen is the one that matters when it differs from the window:
  // a layout question is unanswerable without knowing which viewport is in force.
  const where = screen
    ? `${screen.preset} ${screen.width}x${screen.height} ${screen.orientation}` +
      (screen.zoom < 1 ? ` (shown at ${Math.round(screen.zoom * 100)}%)` : "")
    : `viewport ${v?.w}x${v?.h}`;
  const header =
    `[page ${frame.page?.path ?? "?"} | ${where} @${v?.dpr ?? 1}x | ` +
    `${frame.selectionCount ?? 0} element(s) selected]`;
  if (process.env.UITALK_DEBUG) log(`user header: ${header}`);

  // One or more screenshots the user queued in the panel.
  const shots = Array.isArray(frame.shots) ? frame.shots : frame.png ? [{ png: frame.png, label: "screenshot" }] : [];
  if (!shots.length) return `${header}\n\n${frame.text}`;

  const content = [{ type: "text", text: `${header}\n\n${frame.text}` }];
  for (const [i, shot] of shots.entries()) {
    // Clicks and frames share one clock, so they can be read as a single timeline.
    const caused = shot.triggeredBy?.length
      ? " Interaction timeline, on the same clock as the frame offsets: " +
        shot.triggeredBy
          .map((c) => `${c.at >= 0 ? "+" : ""}${c.at}ms clicked ${c.element?.selector ?? c.element?.tag}`)
          .join("; ") + "."
      : "";
    content.push({ type: "text", text: `Screenshot ${i + 1} of ${shots.length}: ${shot.label}.${caused}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: shot.png } });
  }
  return content;
}

// ------------------------------------------------- transcript replay buffer

// The panel's history lives in page DOM, so a reload loses it while the agent
// keeps remembering. The bridge outlives reloads, so it holds the display copy.
// Finished messages only: replaying hundreds of token deltas would be absurd.
const transcript = [];

function record(role, text) {
  if (!text) return;
  transcript.push({ role, text, at: Date.now() });
  while (transcript.length > config.replayLimit) transcript.shift();
}

// ------------------------------------------------------- context accounting

// A step's total input IS the conversation size at that moment: the prompt the
// API was sent. Dedup by message id, because parallel tool calls repeat it, and
// skip subagents, whose context is their own.
const context = { tokens: 0, percent: 0, seen: new Set(), turnsSinceCompact: 99, compacting: false };

function noteUsage(event) {
  if (event.parent_tool_use_id) return;
  const msg = event.message;
  if (!msg?.id || context.seen.has(msg.id)) return;
  context.seen.add(msg.id);
  const u = msg.usage ?? {};
  const total =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (total > context.tokens) context.tokens = total; // monotonic within a session
  context.percent = Math.round((context.tokens / config.contextTokens) * 1000) / 10;
  toPanel({ kind: "context", tokens: context.tokens, percent: context.percent, limit: config.contextTokens });
}

/** The same meter the SDK events drive, fed by a provider's own usage numbers. */
function noteTokens(total) {
  if (total > context.tokens) context.tokens = total;
  context.percent = Math.round((context.tokens / config.contextTokens) * 1000) / 10;
  toPanel({ kind: "context", tokens: context.tokens, percent: context.percent, limit: config.contextTokens });
}

/**
 * Turn-end, shared across every agent mode. Also where the undo snapshot's
 * post-edit state gets frozen, once, before a later user edit could otherwise
 * be mistaken for the agent's own change. See snapshots.mjs's captureAfter().
 */
async function noteTurnEnded() {
  if (lastChange?.snap && !lastChange.snap.postCaptured) {
    lastChange.snap = await snapshots.captureAfter(PROJECT, lastChange.snap);
    approvalPhase = "idle";
  }
  maybeCompact();
}

/** Compact between turns, never inside one: mid-turn the history is still in use. */
function maybeCompact() {
  context.turnsSinceCompact++;
  if (
    config.autoCompact &&
    !context.compacting &&
    context.percent >= config.compactAtPercent &&
    context.turnsSinceCompact > config.compactCooldownTurns
  ) {
    void compact(`context reached ${context.percent}% of ${config.contextTokens}`);
  }
}

function resetContextMeter() {
  context.tokens = 0;
  context.percent = 0;
  context.seen.clear();
  context.turnsSinceCompact = 0;
  toPanel({ kind: "context", tokens: 0, percent: 0, limit: config.contextTokens });
}

const SUMMARY_REQUEST =
  "Before this session's context is recycled, write a handover note for your own next turn. " +
  "Cover: what this app is and which files you have already opened or edited; the user's " +
  "standing preferences and anything they rejected and why; which elements are selected and " +
  "what we are currently working on; and any decision that would be expensive to rediscover. " +
  "Write it as notes to yourself, not a report to the user, and keep it under 300 words.";

// /compact is terminal-only: sent as a message it is read as plain English, not a
// command. /clear is honoured, so compaction here is summarize -> clear -> reseed.
// That is lossier than an incremental compaction, which is why the threshold is
// worth tuning rather than setting low by reflex.
async function compact(reason) {
  if (context.compacting) return;
  // With an MCP client the conversation lives in the editor, not here: there is no
  // history to summarize and nothing the bridge could clear.
  if (!session) {
    const why = `there is no conversation here to compact — uitalk is running with ${AGENT_MODES[config.agent]}`;
    log(`compaction skipped: ${why}`);
    toPanel({ kind: "compacting", stage: "failed", reason: why });
    return;
  }
  context.compacting = true;
  log(`compacting: ${reason} (${context.tokens} tokens, ${context.percent}%)`);
  toPanel({ kind: "compacting", stage: "summarizing", reason });

  try {
    const summary = await session.summarize(SUMMARY_REQUEST);
    if (!summary) throw new Error("the agent returned no summary");

    toPanel({ kind: "compacting", stage: "clearing" });
    await session.clear();

    resetContextMeter();
    pushToAgent(
      `Context was just recycled to free space. Here is your own handover note from the ` +
        `session so far — treat it as established fact and carry on:\n\n${summary}`,
    );

    record("note", "— context compacted —");
    toPanel({ kind: "compacted", summary });
    log(`compacted; summary ${summary.length} chars`);
  } catch (err) {
    log(`compaction failed: ${err.message}`);
    toPanel({ kind: "compacting", stage: "failed", reason: err.message });
  } finally {
    context.compacting = false;
  }
}

// A turn whose output we consume ourselves rather than showing as chat.
let internal = null;

function askAgent(text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const arm = () => {
      const timer = setTimeout(() => {
        internal = null;
        reject(new Error("the agent did not finish in time"));
      }, timeoutMs);
      internal = {
        buffer: "",
        done: (value) => {
          clearTimeout(timer);
          internal = null;
          resolve(value);
        },
      };
      pushToAgent(text);
    };
    // An ordinary turn already has the SDK's one "result" event spoken for;
    // arming here too would steal it. Wait for that turn to finish first.
    if (builtinTurnOpen) afterBuiltinTurn.push(arm);
    else arm();
  });
}

async function clearSession() {
  // The transcript and the meter are the bridge's own, so a new session still means
  // something when an MCP client is driving: only the agent-side clear is skipped.
  if (session) await session.clear().catch((err) => log(`clear failed: ${err.message}`));
  transcript.length = 0;
  resetContextMeter();
  lastChange = null;
  approvalPhase = "idle"; // abandon any approval whose turn will now never end
  toPanel({ kind: "cleared" });
  notifyAgents("The user started a new session in the panel. The panel's history was cleared.");
  log(session ? "session cleared on request" : "panel history cleared (no built-in agent)");
}

// An MCP client cannot be sent a message, so anything it needs to know is queued
// and handed to it on its next tool result. Without this it would not learn that a
// change it made was just reverted, and would cheerfully re-apply it.
function notifyAgents(text) {
  if (agents.size) toAgents({ kind: "notice", text });
}

// --------------------------------------------------------------- agent session

const GUIDANCE = `
You are connected to a web page the user is looking at right now, through the "page" tools.

How to work here:
- Call read_selection before proposing anything. The user picks elements in order, and refs
  1, 2, 3 in their message mean those selection refs.
- If a ref comes back "stale" (or a tool refuses it as "no longer exists"), the app re-rendered
  and replaced that element since it was picked. Do not retry the same ref — tell the user in one
  short line and ask them to select it again.
- For a question about position, alignment, or spacing, read the common ancestor's layout
  context that read_selection returns. The correct fix for "align 2 to the top of 1" depends
  entirely on it: align-items or align-self under flex, align-self under grid, a top offset
  under position:relative, a margin change or a restructure in static flow. Do not reach for
  a margin when the parent is a flex or grid container.
- A screenshot is one instant. For anything that moves — a transition, a hover, a loading
  state — use capture's "frames" to take a strip, or "delay" to catch a moment that only
  exists briefly. Describing motion from a single frame is guesswork.
- The page may still be loading. capture never waits for the network: it photographs what is
  on screen, and reports in its warnings anything that had not arrived. When you want the
  finished state, wait_for it first — a selector to appear, or a spinner to disappear — rather
  than sleeping and hoping.
- Before writing CSS to source, call describe_styles. Computed values say what a property
  ended up as; they never say which rule set it. That tool names the file, the selector already
  in use, and what is currently winning — so the edit lands where it will actually take effect
  rather than somewhere that loses the cascade.
- If a change you committed did not take effect, the page will tell you so with the values that
  drifted. Do not re-apply the same edit: call describe_styles and fix the rule that is winning.
- Before searching the project by hand, call locate_source. Dev builds usually know the file and line an
  element came from. Trust "exact" confidence; treat "component" (right file, not necessarily the
  right line) and "candidate" (a served-HTML guess) as a lead to confirm, not a location to edit blind.
- If locate_source's reply includes "reuse" with confirmedFiles > 0, the selected element is a
  component also imported and rendered elsewhere in the project — editing it changes every
  instance, not just the one clicked. possibleFiles alone (a same-named tag whose import couldn't
  be verified) is not decisive — a namesake component elsewhere is common, so treat it as worth a
  glance, not a reason to ask on its own. When confirmedFiles > 0 and the request doesn't already
  settle scope ("this button" vs "every button", "all the cards"), ask_choice before editing:
  change the shared component everywhere, or scope the edit to just this instance. For "just this
  instance," follow how the project already expresses one-off variants — a prop, a wrapper class,
  a scoped override — rather than duplicating the whole component, which should be a
  last resort.
- "Does this hold up on mobile" is capture_breakpoints, not a request for the user to resize.
  It follows the element across widths, since a rectangle means something different at each.
- When the request is a clear, unambiguous change ("make this button blue", "add 8px of gap
  here", "increase the font size to 16px"), edit the source directly — do not preview it first.
  Read the current styles with describe_styles, make the edit, then capture to confirm it took.
- Preview instead of editing directly when the change is exploratory, when more than one
  reasonable interpretation of the request exists, or the user is comparing options. try_style
  shows the change in their real page; it writes nothing. Use capture afterwards to check the
  result against what you intended.
- When the user asks for several versions, use show_options. Then end your turn. Their choice
  arrives as a new message from them.
- For a decision with no visual difference to preview — which approach, which file, a yes/no —
  use ask_choice so they can tap an answer instead of retyping it back to you. Their pick arrives
  the same way: end your turn after calling it and wait.
- A request can arrive with a screenshot and nothing selected. Do not ask the user to go and
  select something you can already identify: scan_region the area the screenshot came from,
  find the element, and pass its "selector" to try_style or show_options. Ask only when the
  screenshot is genuinely ambiguous about which element is meant.
- After a preview is approved, place the change where the project already keeps that kind of
  thing and match its conventions. Never carry a data-uitalk-* attribute into source; those are
  preview handles only.
- Keep replies short. The user is looking at the page, not at text.
`.trim();

/** A tool failure is the agent's business, but the user has to see it too. */
const reportToolFailure = (method, message) => {
  log(`tool ${method} failed: ${message}`);
  toPanel({ kind: "tool_error", method, text: message });
};

/** The Claude Code session: the SDK brings the loop, the file tools and the auth. */
async function runBuiltin() {
  let query, pageServer;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
    // Also an SDK import: the tools have to be shaped the way it wants them.
    const { createPageServer } = await import("./page-tools.mjs");
    pageServer = createPageServer(callPage, reportToolFailure, findInServedHtml, countComponentUsages, findProjectCandidates);
  } catch (err) {
    // An install that skipped optional dependencies is the likely cause, and it is
    // recoverable without reinstalling: the other two modes need nothing extra.
    log("the built-in agent needs @anthropic-ai/claude-agent-sdk, which is not installed.");
    log(`  npm install @anthropic-ai/claude-agent-sdk   (or run with --agent off / --agent adapter)`);
    toPanel({
      kind: "agent_absent",
      text:
        "The built-in agent is not installed (@anthropic-ai/claude-agent-sdk). The page tools " +
        "still work — drive them from an MCP client, or set agent to \"adapter\" to use your own key.",
    });
    return;
  }

  session = {
    mode: "builtin",
    label: "claude",
    summarize: (request) => askAgent(request, 120000),
    clear: () => askAgent("/clear", 60000),
  };

  log(`agent session starting, project root ${PROJECT}`);
  try {
    for await (const event of query({
      prompt: inbox(),
      options: {
        cwd: PROJECT,
        mcpServers: { page: pageServer },
        allowedTools: ["mcp__page__*", "Read", "Edit", "Write", "Grep", "Glob"],
        permissionMode: "acceptEdits",
        appendSystemPrompt: GUIDANCE,
        includePartialMessages: true,
      },
    })) {
      relay(event);
    }
  } catch (err) {
    log("agent session ended:", err.message);
    toPanel({ kind: "error", text: err.message });
  }
}

/** Any model the user has a key for. The loop and the file tools live in adapter.mjs. */
function runAdapter() {
  let adapter;
  try {
    adapter = createAdapter({
      config,
      project: PROJECT,
      callPage,
      report: reportToolFailure,
      toPanel,
      record,
      onUsage: noteTokens,
      onTurnEnd: () => void noteTurnEnded(),
      log,
      systemPrompt: GUIDANCE,
    });
  } catch (err) {
    log(`adapter could not start: ${err.message}`);
    toPanel({ kind: "error", text: err.message });
    return;
  }

  // The key is read here and never by the adapter, so it stays out of a module that
  // also talks to a third party.
  adapter.useCredentials((provider) => settings.credential(provider));
  const { from } = settings.credential(adapter.provider);
  if (from) {
    log(`key for ${adapter.provider} read from ${from}`);
  } else if (config.agentBaseUrl) {
    // A custom base URL is usually a local or self-hosted server that takes no key.
    log(`no key found for ${adapter.provider}, but agentBaseUrl is set (${config.agentBaseUrl}) — proceeding without one`);
  } else {
    log(`no key found for ${adapter.provider}: set UITALK_API_KEY, or write ${settings.paths.credentials}`);
    toPanel({
      kind: "agent_absent",
      text: `No API key for ${adapter.provider}. Set UITALK_API_KEY in the environment, or put it in ${settings.paths.credentials}.`,
    });
  }

  session = adapter;
  adapter.start();
}

const unwrapOpencode = (result) => {
  if (result?.error) {
    throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
  }
  return result?.data;
};

/**
 * An OpenCode session, driven over its HTTP API (@opencode-ai/sdk) rather than
 * in-process like the Claude SDK. OpenCode has no equivalent of custom tool
 * injection — a session only gets tools from its own opencode.jsonc MCP config,
 * the same way any other MCP client gets uitalk's page tools (./mcp.mjs) — so
 * this only owns the conversation loop: sending prompts and relaying OpenCode's
 * event stream back into the panel. It does not manage OpenCode's own auth or
 * model choice; those are whatever the user already has OpenCode configured with.
 */
async function runOpencode() {
  let sdk;
  try {
    sdk = await import("@opencode-ai/sdk");
  } catch (err) {
    log("the OpenCode agent needs @opencode-ai/sdk, which is not installed.");
    log(`  npm install @opencode-ai/sdk   (or run with --agent off / --agent adapter / --agent builtin)`);
    toPanel({
      kind: "agent_absent",
      text:
        "The OpenCode agent is not installed (@opencode-ai/sdk). The page tools still work — " +
        "drive them from an MCP client, or set agent to \"builtin\" or \"adapter\".",
    });
    return;
  }

  const DEFAULT_URL = "http://127.0.0.1:4096";
  const probe = async (baseUrl) => {
    try {
      unwrapOpencode(await sdk.createOpencodeClient({ baseUrl, directory: PROJECT }).session.list());
      return true;
    } catch {
      return false;
    }
  };

  let baseUrl = config.opencodeServerUrl || null;
  let closeServer = null;
  try {
    if (baseUrl) {
      if (!(await probe(baseUrl))) throw new Error(`no OpenCode server answered at ${baseUrl}`);
    } else if (await probe(DEFAULT_URL)) {
      baseUrl = DEFAULT_URL;
    } else {
      log(`no OpenCode server at ${DEFAULT_URL}; starting one`);
      const started = await sdk.createOpencode({});
      baseUrl = started.server.url;
      closeServer = started.server.close;
      process.on("exit", () => closeServer?.());
    }
  } catch (err) {
    log(`could not reach OpenCode: ${err.message}`);
    log(`  is "opencode" installed and on PATH? See https://opencode.ai/docs — or set opencodeServerUrl.`);
    toPanel({
      kind: "agent_absent",
      text:
        `Could not reach OpenCode (${err.message}). Install it and make sure "opencode" is on PATH, ` +
        `or set opencodeServerUrl to one already running.`,
    });
    return;
  }

  const client = sdk.createOpencodeClient({ baseUrl, directory: PROJECT });

  // Best-effort, read-only nudge: the page tools only reach OpenCode through its
  // own MCP config, and there is no safe way to add that ourselves without
  // risking a JSONC file's comments on a round-trip, so this only checks.
  const hasUitalkMcp = ["opencode.jsonc", "opencode.json"].some((f) => {
    try {
      return readFileSync(join(PROJECT, f), "utf8").includes("uitalk");
    } catch {
      return false;
    }
  });
  if (!hasUitalkMcp) {
    log(`no opencode.jsonc/opencode.json in ${PROJECT} mentions uitalk — the page tools may not reach it`);
    toPanel({
      kind: "agent_absent",
      text:
        "OpenCode's config doesn't look like it points at uitalk's MCP server yet, so it may not see " +
        "the page tools. Add uitalk to opencode.jsonc (see the README's \"Other editors\" section).",
    });
  }

  let sessionID;
  try {
    sessionID = unwrapOpencode(await client.session.create({ body: { title: "uitalk" } })).id;
  } catch (err) {
    log(`could not create an OpenCode session: ${err.message}`);
    toPanel({ kind: "error", text: `could not create an OpenCode session: ${err.message}` });
    return;
  }

  // One turn at a time: { said, quiet, seenTools, textLen } while a prompt is in
  // flight, plus resolve/reject when it is a quiet (compaction) turn rather than
  // chat. textLen tracks, per text part id, how much of it has already been
  // relayed — message.part.delta carries the actual incremental text, but
  // message.part.updated resends the part's *full* text on every change (first
  // empty, then complete), so relaying that verbatim would double every reply.
  let turn = null;

  function finishTurn() {
    const t = turn;
    turn = null;
    if (!t) return;
    if (t.quiet) return t.resolve(t.said.trim());
    if (t.said.trim()) record("agent", t.said.trim());
    toPanel({ kind: "turn_end" });
    void noteTurnEnded();
  }

  function failTurn(message) {
    const t = turn;
    turn = null;
    if (!t) return;
    if (t.quiet) return t.reject(new Error(message));
    toPanel({ kind: "error", text: message });
    toPanel({ kind: "turn_end", text: "error" });
    // A failed turn may still have written files before it errored — the undo
    // snapshot's post-edit capture needs to run here too, or a revert after a
    // partial failure falls back to the coarser whole-file behavior right when
    // the safer, scoped one matters most.
    void noteTurnEnded();
  }

  (async () => {
    try {
      const { stream } = await client.event.subscribe({ query: { directory: PROJECT } });
      for await (const ev of stream) {
        // A part carries no role of its own — only its messageID — and the
        // prompt's own text comes back as a part on the *user* message it was
        // sent as, on the same session, before the assistant message even
        // exists. Relaying it verbatim would echo every prompt into its own
        // reply, so nothing is relayed until its messageID is known assistant.
        if (ev.type === "message.updated") {
          const info = ev.properties.info;
          if (turn && info.sessionID === sessionID && info.role === "assistant") {
            turn.assistantMessageIds.add(info.id);
          }
          continue;
        }
        if (ev.type === "message.part.delta") {
          const p = ev.properties;
          if (!turn || p.sessionID !== sessionID || !turn.assistantMessageIds.has(p.messageID)) continue;
          if (p.field !== "text" || !p.delta) continue;
          turn.said += p.delta;
          turn.textLen.set(p.partID, (turn.textLen.get(p.partID) ?? 0) + p.delta.length);
          if (!turn.quiet) toPanel({ kind: "delta", text: p.delta });
        } else if (ev.type === "message.part.updated") {
          const part = ev.properties.part;
          if (!turn || part.sessionID !== sessionID || !turn.assistantMessageIds.has(part.messageID)) continue;
          if (part.type === "text") {
            // Whatever this part's deltas have not already covered — normally
            // nothing, since the final "updated" for a part just confirms what
            // its deltas already sent; this only relays anything for a part that
            // (rarely) completed with no delta events of its own.
            const already = turn.textLen.get(part.id) ?? 0;
            const chunk = part.text.slice(already);
            if (!chunk) continue;
            turn.said += chunk;
            turn.textLen.set(part.id, part.text.length);
            if (!turn.quiet) toPanel({ kind: "delta", text: chunk });
          } else if (part.type === "tool" && part.state.status !== "pending" && !turn.seenTools.has(part.callID)) {
            turn.seenTools.add(part.callID);
            if (!turn.quiet) toPanel({ kind: "tool", name: part.tool });
          } else if (part.type === "step-finish") {
            const t = part.tokens ?? {};
            noteTokens((t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0));
          }
        } else if (ev.type === "permission.updated") {
          if (ev.properties.sessionID !== sessionID) continue;
          // Mirrors the built-in session's permissionMode: "acceptEdits" — a real
          // edit is already gated behind uitalk's own approval, upstream of this.
          client
            .postSessionIdPermissionsPermissionId({
              path: { id: sessionID, permissionID: ev.properties.id },
              body: { response: "once" },
            })
            .catch((err) => log(`could not approve an OpenCode permission request: ${err.message}`));
        } else if (ev.type === "session.idle") {
          if (ev.properties.sessionID === sessionID) finishTurn();
        } else if (ev.type === "session.error") {
          if (!ev.properties.sessionID || ev.properties.sessionID === sessionID) {
            failTurn(ev.properties.error?.message ?? "the OpenCode session ended with an error");
          }
        }
      }
    } catch (err) {
      log(`OpenCode event stream ended: ${err.message}`);
      failTurn(`lost the connection to OpenCode: ${err.message}`);
    }
  })();

  const toParts = (content) =>
    normalize(content).map((p) =>
      p.png
        ? { type: "file", mime: "image/png", filename: "screenshot.png", url: `data:image/png;base64,${p.png}` }
        : { type: "text", text: p.text });

  let busy = Promise.resolve();
  const queue = (fn) => (busy = busy.then(fn, fn));

  session = {
    mode: "opencode",
    label: "opencode",

    send(content) {
      queue(async () => {
        turn = { said: "", quiet: false, seenTools: new Set(), textLen: new Map(), assistantMessageIds: new Set() };
        try {
          unwrapOpencode(
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: toParts(content), system: GUIDANCE },
            }),
          );
        } catch (err) {
          failTurn(err.message);
        }
      });
    },

    /** The handover note compaction needs. Asked for without showing it as chat. */
    summarize(request) {
      return queue(
        () =>
          new Promise((resolve, reject) => {
            turn = { said: "", quiet: true, seenTools: new Set(), textLen: new Map(), assistantMessageIds: new Set(), resolve, reject };
            client.session
              .promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: request }] } })
              .then((res) => res?.error && failTurn(JSON.stringify(res.error)))
              .catch((err) => failTurn(err.message));
          }),
      );
    },

    /** A fresh OpenCode session; the old one is simply left behind, not deleted. */
    clear() {
      return queue(async () => {
        sessionID = unwrapOpencode(await client.session.create({ body: { title: "uitalk" } })).id;
      });
    },
  };

  toPanel({ kind: "status", text: "ready · opencode" });
  log(`OpenCode session ready: ${sessionID} (${baseUrl})`);
}

function runSession() {
  if (config.agent === "off") {
    log("no built-in agent (agent: off) — drive the page from an MCP client:");
    log(`  {"mcpServers":{"uitalk":{"command":"uitalk-mcp","env":{"UITALK_PORT":"${port}"}}}}`);
    toPanel({
      kind: "agent_absent",
      text: "Driven from your editor over MCP. The tools below still work; the chat is in your editor.",
    });
    return;
  }
  if (config.agent === "adapter") return runAdapter();
  if (config.agent === "opencode") return void runOpencode();
  return void runBuiltin();
}

let turnText = "";

// Forward only what the panel renders, so the socket stays light.
function relay(event) {
  if (process.env.UITALK_DEBUG) {
    const extra = event.type === "result" ? ` subtype=${event.subtype} turns=${event.num_turns} err=${event.is_error}` : "";
    if (event.type !== "stream_event") log(`event ${event.type}${extra}`);
    if (process.env.UITALK_DEBUG === "2" && (event.type === "result" || event.type === "assistant")) {
      log(JSON.stringify(event).slice(0, 2500));
    }
  }
  switch (event.type) {
    case "system":
      if (event.subtype === "init") toPanel({ kind: "status", text: `ready · ${event.model ?? "agent"}` });
      return;

    case "stream_event": {
      const delta = event.event?.delta;
      if (delta?.type !== "text_delta") return;
      if (internal) internal.buffer += delta.text;
      else {
        turnText += delta.text;
        toPanel({ kind: "delta", text: delta.text });
      }
      return;
    }

    case "assistant":
      noteUsage(event);
      if (internal) return;
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") toPanel({ kind: "tool", name: block.name });
      }
      return;

    case "result": {
      if (event.subtype !== "success") log(`turn ended abnormally: ${event.subtype}`);
      builtinTurnOpen = false;

      if (internal) {
        internal.done(internal.buffer.trim());
      } else {
        record("agent", turnText.trim());
        turnText = "";
        toPanel({ kind: "turn_end", text: event.subtype === "success" ? undefined : event.subtype });
        void noteTurnEnded();
      }

      // An internal ask that arrived while this turn was open was queued
      // rather than dropped; run it now that the SDK is free to take it.
      const next = afterBuiltinTurn.shift();
      if (next) next();
      return;
    }
  }
}

// `--list` reports the other bridges instead of starting one.
if (process.argv.includes("--list")) {
  const running = registry.list();
  if (!running.length) console.log("no bridges running");
  for (const e of running) {
    console.log(`  :${e.port} -> ${e.appHost}:${e.appPort}  pid ${e.pid}  ${e.project}`);
  }
  process.exit(0);
}

/** Bind is atomic, so claiming a port by attempting it is race-free. */
function listen(candidates) {
  const [next, ...rest] = candidates;
  if (next === undefined) {
    log(`no free port in ${PORT_RANGE[0]}-${PORT_RANGE.at(-1)}; set UITALK_PORT to choose one`);
    process.exit(1);
  }
  port = next;
  http.once("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (FIXED_PORT) {
      log(`port ${FIXED_PORT} is taken. Leave UITALK_PORT unset to pick a free one, or run --list.`);
      process.exit(1);
    }
    listen(rest);
  });
  http.listen(next, "127.0.0.1", ready);
}

let lastChange = null;

// One approval's snapshot-then-edit lifecycle at a time. "idle": nothing in
// flight, or the previous edit's turn already ended and got captured — a new
// approval may proceed. "snapshotting": the pre-edit snapshot hasn't resolved
// yet, so the agent must not be told about the edit. "editing": the agent has
// the instruction and is expected to write, and captureAfter() is still owed
// once its turn ends (see noteTurnEnded()). A second approval arriving in
// either of the non-idle phases is refused rather than raced — see the
// "approval" case below.
let approvalPhase = "idle";
let started = false;

function ready() {
  // Each retry registers another listen callback, so without this guard a
  // successful bind after a retry would start a second agent session in the
  // same process.
  if (started) return;
  started = true;

  const twin = registry.servingApp(APP_HOST, APP_PORT);
  if (twin) {
    log(`note: bridge on :${twin.port} (pid ${twin.pid}) already fronts ${APP_HOST}:${APP_PORT}`);
  }
  registry.add({ pid: process.pid, port, appHost: APP_HOST, appPort: APP_PORT, project: PROJECT });

  const others = registry.list().filter((e) => e.pid !== process.pid);
  log(`proxying 127.0.0.1:${port} -> ${APP_HOST}:${APP_PORT}`);
  log(`open http://127.0.0.1:${port} and the panel is injected for you`);
  log(`or http://127.0.0.1:${port}/__uitalk/shell for split screen with device sizes`);
  log(`project ${PROJECT}   client build ${readClient().build}`);
  log(`agent: ${config.agent} — ${AGENT_MODES[config.agent] ?? "unknown mode"}`);
  if (config.agent !== "off") {
    log(
      `context: compact at ${config.compactAtPercent}% of ${config.contextTokens} tokens` +
        `${config.autoCompact ? "" : " (auto-compaction off)"}`,
    );
  }
  if (others.length) log(`${others.length} other bridge(s) running: ${others.map((e) => `:${e.port}`).join(" ")}`);
  runSession();
}

// Importing this module must not start a bridge: the tests exercise the message
// building, transcript and context accounting without a socket or an agent.
if (process.env.UITALK_IMPORT_ONLY !== "1") listen(FIXED_PORT ? [FIXED_PORT] : PORT_RANGE);

export {
  wss,
  http,
  clients,
  agents,
  callPage,
  settleRpc,
  buildUserContent,
  findInServedHtml,
  servedHtml,
  transcript,
  record,
  context,
  noteUsage,
  resetContextMeter,
  relay,
  inbox,
  pushToAgent,
  readClient,
  checkServerFreshness,
  compact,
  clearSession,
  notifyAgents,
  noteTokens,
  maybeCompact,
  AGENT_MODES,
  askAgent,
  setSessionForTest,
  setSnapshotForTest,
  approvalPhaseForTest,
};

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  registry.remove();
  http.close();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);
process.on("exit", () => registry.remove());
