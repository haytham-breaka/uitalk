// Two-turn harness: ask for alternatives, approve one, watch the agent commit it
// to source. Selection mirrors a real app's DOM so the edit has a real target.

import WebSocket from "ws";
import { makePng } from "./make-png.mjs";

const PROMPT = process.argv.slice(2).join(" ") || "Give me 3 versions of the submit button. Keep it on brand.";
const PNG = makePng(420, 120);
const APPROVE_INDEX = 1; // approve the second option

const SELECTION = {
  selected: 2,
  page: { url: "http://localhost:5173/", path: "/", title: "Wedjo", viewport: { w: 1440, h: 900, dpr: 2 } },
  items: [
    {
      ref: 1, tag: "input", classes: ["notify-input"], name: "email", text: undefined,
      selector: '[data-uitalk-ref="1"]', sourceSelector: "form.notify-form > input.notify-input",
      rect: { x: 510, y: 520, w: 420, h: 52 }, depth: 0, directChildOfAncestor: true,
      metrics: { margin: "0px", padding: "14px 18px", alignSelf: "auto", position: "static", fontSize: "16px" },
    },
    {
      ref: 2, tag: "button", classes: ["notify-button"], text: "Notify me",
      selector: '[data-uitalk-ref="2"]', sourceSelector: "form.notify-form > button.notify-button",
      rect: { x: 510, y: 584, w: 420, h: 52 }, depth: 0, directChildOfAncestor: true,
      metrics: { margin: "0px", padding: "14px 18px", alignSelf: "auto", position: "static", fontSize: "16px" },
    },
  ],
  ancestor: {
    tag: "form", classes: ["notify-form"], selector: "form.notify-form",
    layout: { display: "flex", position: "static", flexDirection: "column", alignItems: "center", gap: "12px" },
  },
  deltas: [{ pair: "2 relative to 1", topOffset: 64, leftOffset: 0, widthDiff: 0, heightDiff: 0, verticalGap: 12 }],
};

const ws = new WebSocket("ws://127.0.0.1:8400/__uitalk/socket");
let mounted = null;
let turns = 0;
const reply = (id, result) => ws.send(JSON.stringify({ kind: "rpc_result", id, result }));

ws.on("open", () =>
  setTimeout(() => {
    console.log(`[page] > ${PROMPT}\n`);
    ws.send(JSON.stringify({ kind: "chat", text: PROMPT, page: SELECTION.page, selectionCount: 2 }));
  }, 1200),
);

ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());

  if (f.kind === "rpc") {
    console.log(`\n[page] <- ${f.method}`);
    if (f.method === "readSelection") return reply(f.id, SELECTION);
    if (f.method === "showOptions") {
      mounted = f.params;
      console.log(`[page]    mounted ${f.params.options.length}: ${f.params.options.map((o) => o.label).join(" | ")}`);
      return reply(f.id, { mounted: f.params.options.length, active: 1, labels: f.params.options.map((o) => o.label) });
    }
    if (f.method === "tryStyle") return reply(f.id, { applied: true, ref: f.params.ref });
    if (f.method === "resetPreview") return reply(f.id, { reset: true });
    if (f.method === "capture")
      return reply(f.id, { png: PNG, width: 420, height: 120, dpr: 2, inventory: [] });
    return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id, error: `unknown ${f.method}` }));
  }

  if (f.kind === "delta") process.stdout.write(f.text);
  if (f.kind === "tool") process.stdout.write(`\n[tool ${f.name}] `);
  if (f.kind === "error") console.log(`\n[page] error: ${f.text}`);

  if (f.kind === "turn_end") {
    turns++;
    if (turns === 1) {
      if (!mounted) {
        console.log("\n\n[page] FAIL: the agent never called show_options");
        process.exit(1);
      }
      const choice = mounted.options[APPROVE_INDEX];
      console.log(`\n\n[page] approving option ${APPROVE_INDEX + 1}: "${choice.label}"\n`);
      ws.send(
        JSON.stringify({
          kind: "approval",
          ref: mounted.ref,
          label: choice.label,
          declarations: choice.declarations,
          also: choice.also,
          element: SELECTION.items[mounted.ref - 1],
          page: SELECTION.page,
        }),
      );
      return;
    }
    console.log("\n\n[page] done");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (e) => { console.error("[page] socket error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[page] timed out"); process.exit(1); }, 300000);
