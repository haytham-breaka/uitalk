// A stand-in for the browser: connects to the bridge, answers the page RPCs with
// a fixed synthetic selection, and prints what the agent does. Used to exercise
// the agent -> bridge -> page loop without a browser in the way.
//
//   node tools/fake-page.mjs "align element 2 to the top of element 1"

import WebSocket from "ws";
import { makePng } from "./make-png.mjs";

const PROMPT = process.argv.slice(2).join(" ") || "What is selected, and how are the two elements positioned relative to each other?";
const PNG = makePng(420, 120);

// A flex row whose items are centre-aligned: element 2 sits 14px below 1.
// The idiomatic fix is align-self / align-items, never a margin.
const SELECTION = {
  selected: 2,
  page: { url: "http://localhost:5173/", path: "/", title: "Wedjo", viewport: { w: 1440, h: 900, dpr: 2 } },
  items: [
    {
      ref: 1, tag: "div", classes: ["hero-copy"], text: "Plan the wedding, not the spreadsheet",
      selector: '[data-uitalk-ref="1"]', sourceSelector: "section.hero > div.hero-copy",
      rect: { x: 120, y: 180, w: 520, h: 260 }, depth: 0, directChildOfAncestor: true,
      metrics: { margin: "0px", padding: "0px", alignSelf: "auto", position: "static", fontSize: "16px" },
    },
    {
      ref: 2, tag: "form", classes: ["waitlist-form"], testId: "waitlist", text: "Join the waitlist",
      selector: '[data-uitalk-ref="2"]', sourceSelector: "section.hero > form.waitlist-form",
      rect: { x: 700, y: 194, w: 380, h: 232 }, depth: 0, directChildOfAncestor: true,
      metrics: { margin: "0px", padding: "24px", alignSelf: "auto", position: "static", fontSize: "16px" },
    },
  ],
  ancestor: {
    tag: "section", classes: ["hero"], selector: "section.hero",
    layout: { display: "flex", position: "relative", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "48px" },
  },
  deltas: [{ pair: "2 relative to 1", topOffset: 14, leftOffset: 580, widthDiff: -140, heightDiff: -28, verticalGap: -246 }],
};

const applied = [];
const ws = new WebSocket(`ws://127.0.0.1:${process.env.UITALK_TEST_PORT ?? 8400}/__uitalk/socket`);

const reply = (id, result) => ws.send(JSON.stringify({ kind: "rpc_result", id, result }));

ws.on("open", () => {
  console.log("[page] connected");
  setTimeout(() => {
    console.log(`[page] > ${PROMPT}\n`);
    ws.send(JSON.stringify({ kind: "chat", text: PROMPT, page: SELECTION.page, selectionCount: 2 }));
  }, 1200);
});

ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());

  if (f.kind === "rpc") {
    console.log(`\n[page] <- ${f.method} ${JSON.stringify(f.params ?? {})}`);
    switch (f.method) {
      case "readSelection":
        return reply(f.id, SELECTION);
      case "capture":
        return reply(f.id, { png: PNG, width: 420, height: 120, dpr: 2, page: SELECTION.page, inventory: [] });
      case "scanRegion":
        return reply(f.id, { region: f.params, elements: [] });
      case "tryStyle":
        applied.push(f.params);
        return reply(f.id, { applied: true, ref: f.params.ref });
      case "showOptions":
        applied.push(f.params);
        return reply(f.id, { mounted: f.params.options.length, active: 1, labels: f.params.options.map((o) => o.label) });
      case "resetPreview":
        return reply(f.id, { reset: true });
      default:
        return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id, error: `unknown ${f.method}` }));
    }
  }

  if (f.kind === "delta") process.stdout.write(f.text);
  if (f.kind === "tool") process.stdout.write(`\n[tool ${f.name}] `);
  if (f.kind === "error") console.log(`\n[page] error: ${f.text}`);

  if (f.kind === "turn_end") {
    console.log("\n\n──── applied to the page ────");
    console.log(applied.length ? JSON.stringify(applied, null, 2) : "(nothing)");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (e) => {
  console.error("[page] socket error:", e.message);
  process.exit(1);
});
setTimeout(() => { console.error("[page] timed out"); process.exit(1); }, 180000);
