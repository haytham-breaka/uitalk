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
  const { wss, clients } = await import("./server/index.mjs");
  const { createServer } = await import("node:http");
  const http = createServer((req, res) => res.end("ok"));
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/__uitalk/socket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  // Exit cleanly on SIGTERM: a killed process writes no coverage, and this child
  // runs the bridge code the suite is measuring.
  process.on("SIGTERM", () => process.exit(0));
  http.listen(0, "127.0.0.1", () => console.log("PORT " + http.address().port));
`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, UITALK_IMPORT_ONLY: "1" } });

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
check("it advertises the page tools to any MCP client", listed.result.tools.length === 12,
  `${listed.result.tools.length} tools`);
check("every tool is described well enough to choose from",
  listed.result.tools.every((t) => (t.description ?? "").length > 60));
check("read-only tools are flagged, so a client can batch them",
  listed.result.tools.find((t) => t.name === "read_selection")?.annotations?.readOnlyHint === true);
check("a mutating tool is not flagged read-only",
  listed.result.tools.find((t) => t.name === "try_style")?.annotations?.readOnlyHint === false);
check("schemas are real JSON Schema, not a Zod object",
  listed.result.tools.every((t) => t.inputSchema?.type === "object"));

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

// Closing stdin is how a stdio MCP server is meant to end; killing it would lose
// its coverage and skip its teardown.
mcp.stdin.end();
await new Promise((r) => { mcp.on("exit", r); setTimeout(r, 2000); });
page.close();
bridge.kill("SIGTERM");
await new Promise((r) => { bridge.on("exit", r); setTimeout(r, 2000); });
console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
