// The standalone MCP server, end to end: a bridge, a page answering its calls, and
// an MCP client driving the tools over stdio — the path any editor that is not
// Claude Code would take.

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
};

// A bridge with no agent: UITALK_IMPORT_ONLY keeps the session out of it, so this costs
// no tokens. The socket and the router are the parts under test.
const bridge = spawn("node", ["-e", `
  process.env.UITALK_IMPORT_ONLY = "1";
  const { wss, clients, agents } = await import("./server/index.mjs");
  const { createServer } = await import("node:http");
  const http = createServer((req, res) => {
    // Test hook: drop just the agent (MCP) sockets, leaving the bridge up, so the
    // MCP server sees its socket close and reconnects to the same live bridge.
    if (req.url === "/__drop_agents") { for (const a of [...agents]) a.close(); res.end("dropped"); return; }
    res.end("ok");
  });
  http.on("upgrade", (req, socket, head) => {
    // Match on the pathname, like the real bridge — the MCP client now appends a
    // ?token=… query the exact-string check would (wrongly) reject.
    if (new URL(req.url, "http://127.0.0.1").pathname !== "/__uitalk/socket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  // Exit cleanly on SIGTERM: a killed process writes no coverage, and this child
  // runs the bridge code the suite is measuring.
  process.on("SIGTERM", () => process.exit(0));
  http.listen(0, "127.0.0.1", () => console.log("PORT " + http.address().port));
`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, UITALK_IMPORT_ONLY: "1", UITALK_AGENT: "off" } });

const port = await new Promise((resolve, reject) => {
  let buf = "";
  bridge.stdout.on("data", (d) => {
    buf += d;
    const m = /PORT (\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
  bridge.stderr.on("data", (d) => reject(new Error(String(d).slice(0, 300))));
  setTimeout(() => reject(new Error("the test bridge never started")), 8000);
});
check("a bridge is listening for the MCP server to reach", port > 0, `port ${port}`);

// The page the tools will be asking.
const asked = [];
const page = new WebSocket(`ws://127.0.0.1:${port}/__uitalk/socket`);
page.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.kind !== "rpc") return;
  asked.push(f.method);
  const result =
    f.method === "readSelection" ? { selected: 2, items: [{ ref: 1 }, { ref: 2 }] }
    : f.method === "describeStyles" ? { winners: { padding: { value: "14px", from: ".btn in app.css" } } }
    : f.method === "tryStyle" ? { applied: true }
    : { ok: true };
  page.send(JSON.stringify({ kind: "rpc_result", id: f.id, result }));
});
await new Promise((r) => page.on("open", r));
// The real injected client announces itself on connect (client/ui.js's hello);
// the bridge routes page RPCs only to a socket that has, so do the same here.
page.send(JSON.stringify({ kind: "hello", url: "http://127.0.0.1:8400/", visible: true }));
await new Promise((r) => setTimeout(r, 50));

// The MCP client: plain JSON-RPC over the server's stdio.
const mcp = spawn("node", ["server/mcp.mjs"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, UITALK_PORT: String(port) },
});
let buffer = "";
const waiting = new Map();
mcp.stdout.on("data", (d) => {
  buffer += d;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    } catch {}
  }
});

let id = 0;
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mine = ++id;
    waiting.set(mine, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
  });

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });

const listed = await rpc("tools/list");
check("it advertises the page tools to any MCP client", listed.result.tools.length === 15,
  `${listed.result.tools.length} tools`);
check("note_edit is offered, so an MCP client can make its edit undoable",
  listed.result.tools.some((t) => t.name === "note_edit"),
  listed.result.tools.map((t) => t.name).join(", "));
check("every tool is described well enough to choose from",
  listed.result.tools.every((t) => (t.description ?? "").length > 60));
check("read-only tools are flagged, so a client can batch them",
  listed.result.tools.find((t) => t.name === "read_selection")?.annotations?.readOnlyHint === true);
check("a mutating tool is not flagged read-only",
  listed.result.tools.find((t) => t.name === "try_style")?.annotations?.readOnlyHint === false);
check("schemas are real JSON Schema, not a Zod object",
  listed.result.tools.every((t) => t.inputSchema?.type === "object"));
{
  const opts = listed.result.tools.find((t) => t.name === "show_options")?.inputSchema?.properties?.options;
  check("MCP exposes show_options' minItems/maxItems constraint",
    opts?.minItems === 2 && opts?.maxItems === 10, JSON.stringify(opts && { minItems: opts.minItems, maxItems: opts.maxItems }));
}

// A malformed tool call is rejected at the boundary with a useful message, and
// never reaches the page (asked stays empty for it).
const beforeBad = asked.length;
const badOptions = await rpc("tools/call", { name: "show_options", arguments: { options: [] } });
check("show_options with too few options fails cleanly over the real MCP path",
  badOptions.result?.isError === true && /between 2 and 10/.test(badOptions.result.content[0].text),
  badOptions.result?.content?.[0]?.text?.slice(0, 60));
check("and the malformed show_options never reached the page", asked.length === beforeBad);

// note_edit is request/response now: with no approved change waiting, it reports the
// truth (undo not ready) instead of a fire-and-forget "recorded".
const noted = await rpc("tools/call", { name: "note_edit", arguments: {} });
check("note_edit reports truthfully when there was no approved change to record",
  /"undoReady": ?false/.test(noted.result.content[0].text) && /no approved change/.test(noted.result.content[0].text),
  noted.result.content[0].text.replace(/\s+/g, " ").slice(0, 100));
check("note_edit advertises the optional files list for scoped undo",
  listed.result.tools.find((t) => t.name === "note_edit")?.inputSchema?.properties?.files?.type === "array",
  JSON.stringify(listed.result.tools.find((t) => t.name === "note_edit")?.inputSchema?.properties));
const notedFiles = await rpc("tools/call", { name: "note_edit", arguments: { files: ["src/Button.css", 42, ""] } });
check("note_edit accepts a files list (junk entries filtered) and answers over stdio",
  /"undoReady":/.test(notedFiles.result.content[0].text), notedFiles.result.content[0].text.replace(/\s+/g, " ").slice(0, 60));

// After a real approved change (consumed through await_choice, as a client would),
// note_edit confirms undo IS ready — the bridge recorded the post-edit state before
// answering, rather than claiming success fire-and-forget.
{
  const awaiting = rpc("tools/call", { name: "await_choice", arguments: { timeout: 5000 } });
  await new Promise((r) => setTimeout(r, 50));
  page.send(JSON.stringify({ kind: "approval", label: "ack change", ref: 1,
    declarations: "color: blue", element: { selector: ".x" } }));
  await awaiting;
  const done = await rpc("tools/call", { name: "note_edit", arguments: { files: ["src/x.css"] } });
  check("note_edit confirms undo is ready once an approved change has been recorded",
    /"undoReady": ?true/.test(done.result.content[0].text), done.result.content[0].text.replace(/\s+/g, " ").slice(0, 90));
}

const sel = await rpc("tools/call", { name: "read_selection", arguments: {} });
check("calling a tool reaches the page", asked.includes("readSelection"), asked.join(", "));
check("and the page's answer comes back as content",
  /"selected": 2/.test(sel.result.content[0].text), sel.result.content[0].text.slice(0, 40));

const styled = await rpc("tools/call", { name: "describe_styles", arguments: { ref: 1 } });
check("arguments are passed through", /app\.css/.test(styled.result.content[0].text),
  styled.result.content[0].text.slice(0, 60));

const unknown = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
check("an unknown tool is an error result, not a crash", unknown.result?.isError === true,
  JSON.stringify(unknown.result ?? unknown.error).slice(0, 60));

// The approval flow: a client that cannot be sent a message asks for the choice.
const pending = rpc("tools/call", { name: "await_choice", arguments: { timeout: 5000 } });
await new Promise((r) => setTimeout(r, 300));
page.send(JSON.stringify({ kind: "approval", ref: 1, label: "Rounded",
  declarations: "border-radius: 999px", element: { selector: "button.go" } }));
const chosen = await pending;
check("a user's approval reaches a client that cannot be pushed to",
  /Rounded/.test(chosen.result.content[0].text), chosen.result.content[0].text.slice(0, 60));
check("with the CSS they approved",
  /border-radius: 999px/.test(chosen.result.content[0].text));

const nothing = await rpc("tools/call", { name: "await_choice", arguments: { timeout: 1000 } });
check("waiting when nobody chooses times out rather than hanging",
  /did not pick anything/.test(nothing.result.content[0].text), nothing.result.content[0].text.slice(0, 60));

// The same gap, for a plain ask_choice question rather than a CSS comparison.
const pendingAnswer = rpc("tools/call", { name: "await_answer", arguments: { timeout: 5000 } });
await new Promise((r) => setTimeout(r, 300));
page.send(JSON.stringify({ kind: "choice_answer", label: "Use flexbox" }));
const answered = await pendingAnswer;
check("a user's ask_choice answer reaches a client that cannot be pushed to",
  /Use flexbox/.test(answered.result.content[0].text), answered.result.content[0].text.slice(0, 60));

const noAnswer = await rpc("tools/call", { name: "await_answer", arguments: { timeout: 1000 } });
check("waiting when nobody answers times out rather than hanging",
  /did not answer/.test(noAnswer.result.content[0].text), noAnswer.result.content[0].text.slice(0, 60));

// Superseding a question must cancel an await still waiting on the previous one:
// show A, await A, show B — A's await must return "nothing picked" now, so the next
// approval can't resolve it as if it were A's answer.
await rpc("tools/call", { name: "show_options", arguments: { ref: 1, options: [{ label: "A1", declarations: "color:red" }, { label: "A2", declarations: "color:blue" }] } });
const awaitA = rpc("tools/call", { name: "await_choice", arguments: { timeout: 8000 } });
await new Promise((r) => setTimeout(r, 100)); // let await_choice park its waiter
await rpc("tools/call", { name: "show_options", arguments: { ref: 2, options: [{ label: "B1", declarations: "color:green" }, { label: "B2", declarations: "color:black" }] } });
const aSettled = await Promise.race([
  awaitA.then((r) => r.result.content[0].text),
  new Promise((res) => setTimeout(() => res(null), 800)),
]);
check("superseding a question cancels its still-waiting await, not leaving it to catch the next answer",
  aSettled !== null && /did not pick anything/.test(aSettled), aSettled ?? "(still waiting — old waiter not cancelled)");

// Something happened in the page that this client has to know about. It cannot be
// told — it is a server — so it has to arrive on the next thing it asks for.
page.send(JSON.stringify({ kind: "clear" }));
await new Promise((r) => setTimeout(r, 300));
const afterNotice = await rpc("tools/call", { name: "read_selection", arguments: {} });
const head = afterNotice.result.content[0].text;
check("what the client could not be told arrives with its next tool result",
  head.startsWith("[uitalk]") && /new session/.test(head), head.slice(0, 70));

const clean = await rpc("tools/call", { name: "read_selection", arguments: {} });
check("and it is delivered once, not stapled to every result afterwards",
  !clean.result.content[0].text.startsWith("[uitalk]"),
  clean.result.content[0].text.slice(0, 40));

// A pick the user makes only AFTER await_choice has already timed out must not be
// handed to a LATER, unrelated question: those options are no longer on screen,
// so mounting a new set supersedes the earlier one's unclaimed answer. (The
// preceding new-session cleared the approval lifecycle, so this approval is not
// refused as mid-change.)
await rpc("tools/call", { name: "show_options",
  arguments: { ref: 1, options: [{ label: "A1", declarations: "color: red" }, { label: "A2", declarations: "color: blue" }] } });
const staleTimeout = await rpc("tools/call", { name: "await_choice", arguments: { timeout: 1000 } });
check("await_choice for the first question times out before any pick",
  /did not pick anything/.test(staleTimeout.result.content[0].text), staleTimeout.result.content[0].text.slice(0, 60));
page.send(JSON.stringify({ kind: "approval", ref: 1, label: "stale-A",
  declarations: "color: red", element: { selector: "a.one" } }));
await new Promise((r) => setTimeout(r, 400)); // let the late approval reach and queue in the MCP server
await rpc("tools/call", { name: "show_options",
  arguments: { ref: 2, options: [{ label: "B1", declarations: "margin: 0" }, { label: "B2", declarations: "margin: 8px" }] } });
const forB = await rpc("tools/call", { name: "await_choice", arguments: { timeout: 1000 } });
check("a stale choice from a timed-out question is not handed to the next question",
  !/stale-A/.test(forB.result.content[0].text) && /did not pick anything/.test(forB.result.content[0].text),
  forB.result.content[0].text.slice(0, 80));

// The same, for ask_choice -> await_answer (choice_answer, no approval lifecycle).
await rpc("tools/call", { name: "ask_choice", arguments: { question: "First?", options: ["yes", "no"] } });
await rpc("tools/call", { name: "await_answer", arguments: { timeout: 1000 } });
page.send(JSON.stringify({ kind: "choice_answer", label: "stale-answer" }));
await new Promise((r) => setTimeout(r, 400));
await rpc("tools/call", { name: "ask_choice", arguments: { question: "Second?", options: ["a", "b"] } });
const answerForSecond = await rpc("tools/call", { name: "await_answer", arguments: { timeout: 1000 } });
check("a stale answer from a timed-out question is not handed to the next question",
  !/stale-answer/.test(answerForSecond.result.content[0].text) && /did not answer/.test(answerForSecond.result.content[0].text),
  answerForSecond.result.content[0].text.slice(0, 80));

// A pick that was queued (no await_choice parked to catch it) must not survive a
// bridge disconnect: after a reconnect it belongs to a session the bridge is no
// longer showing, so a fresh await_choice must NOT be handed it.
{
  // Queue an approval with nothing waiting for it (the MCP server pushes it onto its
  // choices[] queue). Off mode settles each approval, so the coordinator is idle and
  // the approval is relayed to the agent; give the pre-edit snapshot time to resolve.
  page.send(JSON.stringify({ kind: "approval", ref: 1, label: "stale-queued-choice",
    declarations: "border-radius: 8px", element: { selector: ".x" } }));
  await new Promise((r) => setTimeout(r, 1500)); // pre-edit snapshot subprocess + relay + queue in the MCP server

  // Drop the agent socket (bridge stays up); the MCP server reconnects on the next call.
  await fetch(`http://127.0.0.1:${port}/__drop_agents`);
  await new Promise((r) => setTimeout(r, 300));

  const afterReconnect = await rpc("tools/call", { name: "await_choice", arguments: { timeout: 800 } });
  check("a queued approval does not survive a bridge disconnect",
    !/stale-queued-choice/.test(afterReconnect.result.content[0].text),
    afterReconnect.result.content[0].text.slice(0, 80));

  // The same for a queued ask_choice answer.
  await rpc("tools/call", { name: "ask_choice", arguments: { question: "Q?", options: ["yes", "no"] } });
  page.send(JSON.stringify({ kind: "choice_answer", label: "stale-queued-answer" }));
  await new Promise((r) => setTimeout(r, 300));
  await fetch(`http://127.0.0.1:${port}/__drop_agents`);
  await new Promise((r) => setTimeout(r, 300));
  const answerAfter = await rpc("tools/call", { name: "await_answer", arguments: { timeout: 800 } });
  check("a queued answer does not survive a bridge disconnect",
    !/stale-queued-answer/.test(answerAfter.result.content[0].text),
    answerAfter.result.content[0].text.slice(0, 80));
}

// A blocking await_choice must not hang for its full timeout when the bridge
// drops mid-wait: the client's close handler resolves it, as a timeout would.
// (Last, because it takes the bridge down.)
{
  const longWait = rpc("tools/call", { name: "await_choice", arguments: { timeout: 300000 } });
  await new Promise((r) => setTimeout(r, 300)); // let it register its waiter
  bridge.kill("SIGTERM"); // drop the bridge under the blocking call
  const res = await longWait; // must resolve now, not in 5 minutes (rpc's own 15s cap would else fire)
  check("a blocking await_choice returns when the bridge disconnects, not after its full timeout",
    /did not pick/.test(res.result.content[0].text), res.result.content[0].text.slice(0, 60));
}

// Closing stdin is how a stdio MCP server is meant to end; killing it would lose
// its coverage and skip its teardown.
mcp.stdin.end();
await new Promise((r) => { mcp.on("exit", r); setTimeout(r, 2000); });
page.close();
bridge.kill("SIGTERM");
await new Promise((r) => { bridge.on("exit", r); setTimeout(r, 2000); });
console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
