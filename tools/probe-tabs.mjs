// Two pages connected at once. The bridge must send page calls to the one the user
// last used, not to whichever socket happened to connect first — a background tab
// has a different selection and a paused rAF, so a request landing there hangs.
import WebSocket from "ws";

const PORT = process.env.UITALK_TEST_PORT ?? 8400;
const url = `ws://127.0.0.1:${PORT}/__uitalk/socket`;
const page = { path: "/", viewport: { w: 1440, h: 900, dpr: 2 } };

const open = (name) =>
  new Promise((res) => {
    const ws = new WebSocket(url);
    ws.name = name;
    ws.calls = [];
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.kind !== "rpc") return;
      ws.calls.push(f.method);
      ws.send(JSON.stringify({ kind: "rpc_result", id: f.id,
        result: { selected: 1, from: ws.name, items: [], ancestor: {}, deltas: [], page } }));
    });
    ws.on("open", () => res(ws));
  });

const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail.push(n); };

// "stale" connects first and then goes quiet; "active" is the tab in use.
const stale = await open("stale");
const active = await open("active");
await new Promise((r) => setTimeout(r, 400));

active.send(JSON.stringify({ kind: "hello", url: "http://127.0.0.1:8400/", visible: true }));
await new Promise((r) => setTimeout(r, 300));

active.send(JSON.stringify({ kind: "chat", text: "What is selected? Answer in one word.", page, selectionCount: 1 }));
await new Promise((r) => setTimeout(r, 25000));

check("the request went to the active tab", active.calls.length > 0, `active ${active.calls.length}`);
check("the stale tab was not asked", stale.calls.length === 0, `stale ${stale.calls.length}`);

// now the other tab becomes the one in use
stale.send(JSON.stringify({ kind: "focus", url: "http://127.0.0.1:8400/other", visible: true }));
await new Promise((r) => setTimeout(r, 300));
const activeBefore = active.calls.length;
stale.send(JSON.stringify({ kind: "chat", text: "What is selected now? One word.", page, selectionCount: 1 }));
await new Promise((r) => setTimeout(r, 25000));

check("routing follows the tab that just became active", stale.calls.length > 0, `stale ${stale.calls.length}`);
check("the previously active tab is no longer asked", active.calls.length === activeBefore,
  `${activeBefore} -> ${active.calls.length}`);

console.log(fail.length ? `\n${fail.length} failing` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
