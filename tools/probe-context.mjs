// Exercises the context meter, settings round-trip, forced compaction, and the
// replay buffer (by reconnecting a second client).
import WebSocket from "ws";
const PORT = process.env.UITALK_TEST_PORT ?? 8400;
const url = `ws://127.0.0.1:${PORT}/__uitalk/socket`;
const page = { path: "/", viewport: { w: 800, h: 600, dpr: 1 } };

const open = () => new Promise((res) => { const w = new WebSocket(url); w.on("open", () => res(w)); });
const ws = await open();
const send = (f) => ws.send(JSON.stringify(f));
const chat = (text) => send({ kind: "chat", text, page, selectionCount: 0 });

let ready = null, ctx = [], compactStages = [], settingsSeen = null;
const waits = [];
const waitFor = (pred, ms = 180000) =>
  new Promise((res, rej) => { const w = { pred, res }; waits.push(w);
    setTimeout(() => { const i = waits.indexOf(w); if (i >= 0) { waits.splice(i, 1); rej(new Error("timeout")); } }, ms); });

ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.kind === "ready") ready = f;
  if (f.kind === "context") ctx.push(f);
  if (f.kind === "compacting") compactStages.push(f.stage);
  if (f.kind === "compacted") compactStages.push("compacted");
  if (f.kind === "settings") settingsSeen = f;
  for (let i = waits.length - 1; i >= 0; i--) if (waits[i].pred(f)) { waits.splice(i, 1)[0].res(f); }
});

const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail.push(n); };

await waitFor((f) => f.kind === "ready");
check("ready carries settings", !!ready.settings?.compactAtPercent, JSON.stringify(ready.settings));
check("ready carries field schema", !!ready.fields?.compactAtPercent);
check("ready carries a context snapshot", !!ready.context);

// --- settings round trip, including clamping of an out-of-range value
send({ kind: "settings", patch: { compactAtPercent: 999, autoCompact: false } });
await waitFor((f) => f.kind === "settings");
check("settings persisted", settingsSeen.settings.autoCompact === false, JSON.stringify(settingsSeen.settings.autoCompact));
check("out-of-range value clamped", settingsSeen.settings.compactAtPercent === 95, String(settingsSeen.settings.compactAtPercent));
check("clamp reported", settingsSeen.rejected?.some((r) => /clamped/.test(r)), JSON.stringify(settingsSeen.rejected));
check("written to the project file", /\.uitalk\.json$/.test(settingsSeen.written), settingsSeen.written);

// --- a turn should report context usage
chat("Reply with exactly: BADGER");
await waitFor((f) => f.kind === "turn_end");
check("context measured after a turn", ctx.length > 0 && ctx.at(-1).tokens > 0, JSON.stringify(ctx.at(-1)));

// --- forced compaction: summarize -> clear -> reseed, then test recall
send({ kind: "compact_now" });
await waitFor((f) => f.kind === "compacted", 240000);
check("compaction ran both stages", compactStages.includes("summarizing") && compactStages.includes("clearing"),
  compactStages.join(" -> "));
check("context meter reset by compaction", ctx.at(-1).tokens === 0, JSON.stringify(ctx.at(-1)));

// The reseeded handover note must carry facts across a real /clear, or
// compaction is just amnesia with extra steps.
let answer = "";
const collect = (raw) => { const f = JSON.parse(raw.toString()); if (f.kind === "delta") answer += f.text; };
ws.on("message", collect);
chat("Earlier in this session I asked you to reply with one specific word. What was it? Answer with just the word, or UNKNOWN.");
await waitFor((f) => f.kind === "turn_end");
ws.off("message", collect);
check("a fact survived compaction", /BADGER/i.test(answer), answer.trim().slice(0, 60));
await new Promise((r) => setTimeout(r, 500));

// --- replay buffer: a second client should receive the history
const ws2 = await open();
const replay = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no replay")), 15000);
  ws2.on("message", (raw) => { const f = JSON.parse(raw.toString()); if (f.kind === "replay") { clearTimeout(t); res(f); } });
});
check("replay sent to a new client", replay.entries.length > 0, `${replay.entries.length} entries`);
check("replay holds my messages", replay.entries.some((e) => e.role === "me" && /BADGER/.test(e.text)));
check("replay holds agent turns", replay.entries.some((e) => e.role === "agent"));
check("replay notes the compaction", replay.entries.some((e) => e.role === "note" && /compact/.test(e.text)));
check("replay has no raw deltas", replay.entries.every((e) => e.text.length > 0));

console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
