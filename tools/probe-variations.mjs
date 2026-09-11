// Repro: a screenshot is attached, nothing is selected, and the user asks for
// variations. Logs every page call the agent makes and what it ends up saying.
import WebSocket from "ws";
import { makePng } from "./make-png.mjs";

const PNG = makePng(420, 120);
const ws = new WebSocket(`ws://127.0.0.1:${process.env.UITALK_TEST_PORT ?? 8400}/__uitalk/socket`);
const page = { url: "http://localhost:5201/", path: "/", title: "App A", viewport: { w: 1440, h: 900, dpr: 2 } };
const calls = [];
let out = "";

ws.on("open", () => setTimeout(() => {
  console.log("> [screenshot attached, nothing selected] give me 3 variations of this button\n");
  ws.send(JSON.stringify({
    kind: "chat",
    text: "give me 3 variations of this button",
    page, selectionCount: 0,
    shots: [{ png: PNG, label: "420×120 region" }],
  }));
}, 1200));

ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.kind === "rpc") {
    calls.push(f.method);
    console.log(`\n[page] <- ${f.method} ${JSON.stringify(f.params ?? {})}`);
    if (f.method === "readSelection") {
      return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id,
        result: { selected: 0, note: "Nothing is selected. Ask the user to pick an element." } }));
    }
    if (f.method === "capture") {
      return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id,
        result: { png: PNG, width: 420, height: 120, dpr: 2, page, inventory: [] } }));
    }
    if (f.method === "scanRegion") {
      // what the real scanner returns: identity including a usable selector
      return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id, result: { region: f.params, page, elements: [
        { tag: "button", classes: ["notify-button"], text: "Notify me", testId: "notify-submit",
          selector: "button.notify-button", sourceSelector: "form.notify-form > button.notify-button",
          depth: 1, at: { x: 42, y: 36, w: 336, h: 48 } },
      ] } }));
    }
    if (f.method === "showOptions") {
      console.log(`[page]    mounted ${f.params.options.length}: ${f.params.options.map((o) => o.label).join(" | ")}`);
      console.log(`[page]    targeted by: ${f.params.selector ?? "ref " + f.params.ref}`);
      return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id,
        result: { mounted: f.params.options.length, active: 1, labels: f.params.options.map((o) => o.label) } }));
    }
    if (f.method === "tryStyle") {
      return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id, result: { applied: true } }));
    }
    return ws.send(JSON.stringify({ kind: "rpc_result", id: f.id, error: `unsupported: ${f.method}` }));
  }
  if (f.kind === "delta") { out += f.text; process.stdout.write(f.text); }
  if (f.kind === "error") console.log(`\n[error] ${f.text}`);
  if (f.kind === "turn_end") {
    console.log(`\n\n──── page calls: ${calls.join(" -> ") || "(none)"} ────`);
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.error("timed out"); process.exit(1); }, 240000);
