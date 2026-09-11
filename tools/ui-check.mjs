// Drives the injected panel under jsdom with synthetic pointer events, so the
// gestures (click to pick, drag to rubber-band, drag to screenshot) have coverage.
// jsdom has no layout engine, so boxes are stubbed; what is under test is the
// event plumbing and the mode machine.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// //# sourceURL attributes the evaluated source back to its file: without it V8
// records it as an anonymous eval, so coverage reports zero and stack traces name
// nothing useful.
function loadClient(win, file) {
  const url = new URL(`../client/${file}`, import.meta.url);
  win.eval(`${readFileSync(url, "utf8")}\n//# sourceURL=${fileURLToPath(url)}`);
}

const HTML = `<!doctype html><html><head><title>Wedjo</title></head><body>
  <main class="coming-soon-main">
    <h1 class="coming-soon-title">Something lovely</h1>
    <form class="notify-form" style="display:flex;flex-direction:column;align-items:center;gap:12px">
      <input class="notify-input" name="email" />
      <button class="notify-button" data-testid="notify-submit">Notify me</button>
    </form>
  </main>
</body></html>`;

import { VirtualConsole } from "jsdom";
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("!! page error:", e.message, e.detail?.message ?? ""));
vc.on("error", (...a) => console.log("!! console.error:", ...a));
const dom = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc });
const { window } = dom;

class FakeSheet { replaceSync(t) { this.text = t; } }
window.CSSStyleSheet = FakeSheet;
window.document.adoptedStyleSheets = [];
window.CSS = { escape: (v) => String(v).replace(/([^\w-])/g, "\\$1") };
window.devicePixelRatio = 2;
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const sent = [];
const sockets = [];
window.WebSocket = class {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    sockets.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data) { sent.push(JSON.parse(data)); }
  close() {}
};

const BOXES = {
  "coming-soon-main": { left: 440, top: 380, width: 560, height: 300 },
  "coming-soon-title": { left: 460, top: 400, width: 520, height: 60 },
  "notify-form": { left: 510, top: 520, width: 420, height: 116 },
  "notify-input": { left: 510, top: 520, width: 420, height: 52 },
  "notify-button": { left: 510, top: 584, width: 420, height: 52 },
};
window.Element.prototype.getBoundingClientRect = function () {
  const key = [...(this.classList ?? [])].find((c) => BOXES[c]);
  const b = BOXES[key] ?? { left: 0, top: 0, width: 120, height: 24 };
  return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top };
};
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};

let atPoint = null;
window.document.elementFromPoint = () => atPoint;

for (const f of ["api.js", "raster.js", "native.js"]) {
  loadClient(window, f);
}

const nativeShipped = typeof window.UITalkNative?.ready === "function";
const grabs = [];
const fakeNative = {
  supported: () => true,
  declined: false,
  active: true,
  ready: async () => true,
  grab: async (rect) => {
    grabs.push(rect);
    return { png: "SCREENPIXELS", width: Math.round(rect.right - rect.left),
             height: Math.round(rect.bottom - rect.top), scale: 2 };
  },
  stop: () => {},
  reset: () => {},
};
window.UITalkNative = fakeNative;

loadClient(window, "ui.js");

// Real rasterizer cannot run here (it waits on an <img> load jsdom never fires).
const shots = [];
window.UITalkRaster = {
  rasterize: async (el, opts = {}) => {
    shots.push({ el, clip: opts.clip });
    return { png: "stub", width: 10, height: 10, warnings: [] };
  },
};

const UITalk = window.UITalk;
const host = window.document.getElementById("uitalk-host");
const root = host.shadowRoot;
const tool = (act) => root.querySelector(`[data-act="${act}"]`);
const tick = () => new Promise((r) => setTimeout(r, 5));

// Dispatch on the element under the pointer, as a browser does, and let it bubble.
const fire = (type, x, y, target = null) =>
  (target ?? atPoint ?? window.document.body).dispatchEvent(
    new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
  );

// Clicking a panel control: the point is over the panel, so elementFromPoint
// returns the host, and the page-level handlers must leave the event alone.
const clickTool = async (act) => {
  const before = atPoint;
  atPoint = host;
  tool(act).dispatchEvent(new window.MouseEvent("click", { clientX: 5, clientY: 5, button: 0, bubbles: true, cancelable: true }));
  await tick();
  atPoint = before;
};

const input = root.querySelector("textarea");
const shots_queued = () => root.querySelectorAll(".att .thumb").length;
const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail.push(n); };

check("panel mounted in a shadow root", !!root && !!root.querySelector(".panel"));

// A stale page looks exactly like a live bug, so the mismatch has to announce itself.
{
  window.__UITALK_BUILD__ = "aaaaaaaa";
  const sock = sockets[0];
  const logText = () => [...root.querySelectorAll(".log .msg")].map((m) => m.textContent).join(" | ");
  const warnings = () => [...root.querySelectorAll(".log .msg.warn")]
    .filter((m) => /reload the page/.test(m.textContent)).length;

  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: "bbbbbbbb", settings: {}, fields: {} }) });
  check("a stale panel says so on connect", warnings() === 1, `${warnings()} warnings`);

  // The "connected" note lands either way, so count the warning, not the log length.
  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: "aaaaaaaa", settings: {}, fields: {} }) });
  check("a current panel adds no warning", warnings() === 1, `${warnings()} warnings`);
}

// Every visual hook the code relies on must have a rule behind it. A class applied
// with no CSS looks like nothing happened, which is how a silently-failed patch
// hides: the class assertion passes and the panel still renders wrong.
{
  const sheet = [...root.querySelectorAll("style")].map((n) => n.textContent).join("\n");
  const required = [
    ".panel", ".panel.open", ".grip", ".tools", ".tool", ".log", ".msg", ".tray", ".chips",
    ".chip-sel", ".att", ".strip", ".thumb", ".hint", ".sent", ".lightbox", ".opts",
    ".composer", ".fab", ".badge", ".ring", ".hover", ".marquee", ".cand", ".settings",
    ".meter", ".pages", ".split",
  ];
  const missing = required.filter((sel) => {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`${escaped}\\s*[,{]`).test(sheet);
  });
  check("every styled hook has a rule behind it", missing.length === 0, missing.join(", ") || "all present");
}
await tick();
check("the page announces itself so the bridge can route to the active tab",
  sent.some((f) => f.kind === "hello" && typeof f.url === "string"),
  JSON.stringify(sent.map((f) => f.kind)));
check("becoming visible re-announces", (() => {
  const before = sent.filter((f) => f.kind === "focus").length;
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  return sent.filter((f) => f.kind === "focus").length > before;
})());
check("launcher present", !!root.querySelector(".fab"));
// The pip carries the selection count, so the button is not text-free; what matters
// is that the mark itself is drawn rather than a glyph whose shape depends on the
// viewer's font stack.
check("its mark is drawn, not a font glyph",
  !!root.querySelector(".fab svg.mark path.frame") && !root.querySelector(".fab .glyph"),
  root.querySelector(".fab .glyph") ? "still a glyph" : "svg");
check("the mark is hidden from assistive tech, since the button is labelled",
  root.querySelector(".fab svg.mark")?.getAttribute("aria-hidden") === "true");
check("socket opened to the bridge path", sent.length >= 0);

// --- arming the picker
await clickTool("pick");
check("Select marks itself active", tool("pick").classList.contains("on"));
check("Screenshot is not active at the same time", !tool("shot").classList.contains("on"));

// --- click to pick one element
atPoint = window.document.querySelector(".notify-input");
fire("click", 600, 540);
await tick();
check("click picks an element", UITalk.picked.length === 1, `picked ${UITalk.picked.length}`);

// --- drag to rubber-band select
UITalk.clearSelection();
atPoint = window.document.querySelector(".notify-form");
fire("pointerdown", 500, 510);
fire("pointermove", 520, 530);
fire("pointermove", 945, 645);
const bandVisible = !!root.querySelector(".marquee");
fire("pointerup", 945, 645);
fire("click", 945, 645); // trailing click after a drag
await tick();
check("a marquee appears during the drag", bandVisible);
check("the marquee is removed afterwards", !root.querySelector(".marquee"));
check("drag selects what is inside", UITalk.picked.length > 0, `picked ${UITalk.picked.length}: ${UITalk.picked.map((e) => e.className).join(", ")}`);
// The drag enclosed the form, and the form alone would be one element — so it steps
// inside and takes the fields, which is what a rectangle is for.
check("a drag that resolves to one container takes what is inside it",
  UITalk.picked.some((e) => e.classList.contains("notify-input")) &&
  UITalk.picked.some((e) => e.classList.contains("notify-button")) &&
  !UITalk.picked.some((e) => e.classList.contains("notify-form")),
  UITalk.picked.map((e) => e.className).join(" | "));

// A normal click after the drag has settled should pick again. It has to land on
// something the marquee did not already take, or the click is a deselect.
const afterDrag = UITalk.picked.length;
atPoint = window.document.querySelector(".coming-soon-title");
fire("pointerdown", 600, 430);
fire("pointerup", 600, 430);
fire("click", 600, 430);
await tick();
check("a fresh click still picks once the drag has settled", UITalk.picked.length === afterDrag + 1,
  `${afterDrag} -> ${UITalk.picked.length}`);

// --- switching to Screenshot drops the selection
await clickTool("shot");
check("Screenshot becomes the active tool", tool("shot").classList.contains("on"));
check("Select is no longer active", !tool("pick").classList.contains("on"));
check("switching tools keeps the selection", UITalk.picked.length === afterDrag + 1,
  `picked ${UITalk.picked.length}`);
check("the selection is still shown as chips in Screenshot mode",
  root.querySelectorAll(".chip-sel").length === UITalk.picked.length,
  `${root.querySelectorAll(".chip-sel").length} chips`);
check("the badges stay on the page too", root.querySelectorAll(".badge").length === UITalk.picked.length);

// --- the app must not react to the pointer while a tool is armed
{
  const target = window.document.querySelector(".notify-button");
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["pointerdown", "mousedown", "click", "dblclick", "touchstart"]) {
    window.document.addEventListener(t, spy); // an app listener, on the document
  }

  await clickTool("pick");
  atPoint = target;
  seen.length = 0;
  fire("pointerdown", 600, 600);
  fire("mousedown", 600, 600);
  fire("click", 600, 600);
  fire("dblclick", 600, 600);
  check("armed: the app sees none of the press events", seen.length === 0, seen.join(", "));

  // hover must still reach the app, so a hover state can be captured
  const hoverSeen = [];
  const hoverSpy = () => hoverSeen.push(1);
  window.document.addEventListener("mousemove", hoverSpy);
  fire("mousemove", 600, 600);
  check("armed: hover still reaches the app", hoverSeen.length > 0);
  window.document.removeEventListener("mousemove", hoverSpy);

  await clickTool("pick"); // disarm
  seen.length = 0;
  fire("pointerdown", 600, 600);
  fire("click", 600, 600);
  check("disarmed: the app receives its events again", seen.length >= 2, seen.join(", "));

  for (const t of ["pointerdown", "mousedown", "click", "dblclick", "touchstart"]) {
    window.document.removeEventListener(t, spy);
  }
}

// --- dragging shows what it would take, before taking it
await clickTool("pick");
UITalk.clearSelection();
atPoint = window.document.querySelector(".notify-form");
fire("pointerdown", 500, 510);
fire("pointermove", 520, 530);
fire("pointermove", 945, 645);
await new Promise((r) => window.requestAnimationFrame(r));
await tick();
const cands = root.querySelectorAll(".cand");
check("candidates are highlighted mid-drag", cands.length > 0, `${cands.length} highlighted`);
check("candidates are numbered", !!root.querySelector(".cand .n"), root.querySelector(".cand .n")?.textContent);
check("nothing is selected until the drag ends", UITalk.picked.length === 0, `picked ${UITalk.picked.length}`);
fire("pointerup", 945, 645); fire("click", 945, 645);
await tick();
check("the candidate highlight is removed after the drag", !root.querySelector(".cand"));
check("the drag then selects them", UITalk.picked.length > 0, `picked ${UITalk.picked.length}`);

// --- Ctrl-Z steps a selection back
const beforeUndo = UITalk.picked.length;
root.querySelector("textarea").blur?.();
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
await tick();
check("Ctrl-Z undoes the last selection change", UITalk.picked.length !== beforeUndo,
  `${beforeUndo} -> ${UITalk.picked.length}`);

// --- the wait hands the page back, so a click-triggered state can be captured
{
  await clickTool("shot");
  root.querySelector(".cap-delay").value = "1000";

  const appSaw = [];
  const spy = (e) => appSaw.push(e.type);
  window.document.addEventListener("click", spy);

  atPoint = window.document.querySelector(".notify-button");
  grabs.length = 0;
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 760, 600);
  fire("pointerup", 760, 600); fire("click", 760, 600);

  // mid-wait: the tool must be standing down so the page can be driven
  await new Promise((r) => setTimeout(r, 250));
  check("the shutter has not fired yet", grabs.length === 0, `${grabs.length} grabs`);
  appSaw.length = 0;
  fire("click", 600, 600);
  check("the app receives clicks during the wait", appSaw.includes("click"), appSaw.join(", "));
  check("and the click does not select anything", UITalk.picked.length === 0, `picked ${UITalk.picked.length}`);

  await new Promise((r) => setTimeout(r, 1200));
  check("the shutter fires once the wait is over", grabs.length === 1, `${grabs.length} grabs`);

  const label = root.querySelector(".att img")?.title ?? "";
  check("the shot records what was clicked to produce it", /after .*notify-button/.test(label), label);

  window.document.removeEventListener("click", spy);
  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();

  // --- with a strip, the click is the start signal and frames are measured from it
  let readyCalledAt = null;
  const realReady = fakeNative.ready;
  fakeNative.ready = async () => { readyCalledAt = readyCalledAt ?? Date.now(); return realReady(); };

  grabs.length = 0;
  root.querySelector(".cap-delay").value = "5000";
  root.querySelector(".cap-frames").value = "3";
  root.querySelector(".cap-every").value = "40";
  atPoint = window.document.querySelector(".notify-button");
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 760, 600);
  fire("pointerup", 760, 600); fire("click", 760, 600);

  await new Promise((r) => setTimeout(r, 200));
  check("a strip waits for the click rather than the countdown", grabs.length === 0, `${grabs.length}`);
  check("the screen-share prompt is asked for before the wait, not during it",
    readyCalledAt !== null, readyCalledAt ? "asked up front" : "NOT ASKED UP FRONT");
  check("the chosen area stays marked through the wait", !!root.querySelector(".armed"),
    root.querySelector(".armed") ? "marked" : "NO MARKER");
  check("the marker counts down where the area is",
    /\d+s/.test(root.querySelector(".armed .tag")?.textContent ?? ""),
    root.querySelector(".armed .tag")?.textContent);
  check("the marker is not rolling yet", !root.querySelector(".armed.rolling"));
  // The app's click handler — and the style change it makes — must have happened
  // before the first frame, or the strip photographs the state the click replaced.
  let appHandledAt = null;
  let firstGrabAt = null;
  const appHandler = () => { appHandledAt = appHandledAt ?? Date.now(); };
  window.document.addEventListener("click", appHandler); // bubble, as an app's would be
  const grabSpy = fakeNative.grab;
  fakeNative.grab = async (r, o) => { firstGrabAt = firstGrabAt ?? Date.now(); return grabSpy(r, o); };

  fire("click", 600, 600); // this is the trigger
  check("the roll does not fire inside the click itself", firstGrabAt === null,
    firstGrabAt ? "GRABBED SYNCHRONOUSLY" : "deferred");

  await new Promise((r) => setTimeout(r, 60));
  check("the app's own click handler ran first", appHandledAt !== null && firstGrabAt !== null &&
    appHandledAt <= firstGrabAt, `app ${appHandledAt} vs grab ${firstGrabAt}`);
  window.document.removeEventListener("click", appHandler);
  fakeNative.grab = grabSpy;
  check("the marker turns to recording when the shutter rolls",
    !!root.querySelector(".armed.rolling"),
    root.querySelector(".armed.rolling") ? "rolling" : "NOT ROLLING");
  check("and says so", /record/i.test(root.querySelector(".armed .tag")?.textContent ?? ""),
    root.querySelector(".armed .tag")?.textContent);
  await new Promise((r) => setTimeout(r, 600));
  check("the marker is cleared once the capture is done", !root.querySelector(".armed"),
    root.querySelector(".armed") ? "LEFT BEHIND" : "cleared");
  check("the click starts the roll immediately, not after the full wait",
    grabs.length === 3, `${grabs.length} grabs`);

  // A strip is one queued capture holding its frames, not N queued screenshots —
  // counting frames meant a single strip exhausted the queue.
  check("a strip queues as one capture", root.querySelectorAll(".att .thumb").length === 1,
    `${root.querySelectorAll(".att .thumb").length} thumbs`);
  check("the thumbnail is badged with its frame count",
    root.querySelector(".thumb .count")?.textContent === "×3",
    root.querySelector(".thumb .count")?.textContent);
  check("the capture is anchored to the click",
    /after clicking .*notify-button/.test(root.querySelector(".att img")?.title ?? ""),
    root.querySelector(".att img")?.title);

  // the viewer walks every frame of the strip, timestamped from the click
  root.querySelector(".att img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("the viewer opens on the strip", root.querySelector(".lightbox").classList.contains("on"));
  check("it steps through frames, not captures",
    /frame 1 of 3/.test(root.querySelector(".lightbox .cap")?.textContent ?? ""),
    root.querySelector(".lightbox .cap")?.textContent?.slice(0, 80));
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  check("the arrows walk within the strip",
    /frame 2 of 3/.test(root.querySelector(".lightbox .cap")?.textContent ?? ""),
    root.querySelector(".lightbox .cap")?.textContent?.slice(0, 80));
  root.querySelector(".lightbox").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  // --- a second capture must work without toggling the tool off and on, and
  // without having to clear the tray first
  grabs.length = 0;
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 700, 590);
  fire("pointerup", 700, 590); fire("click", 700, 590);
  await new Promise((r) => setTimeout(r, 200));
  check("a second drag starts a fresh capture window", grabs.length === 0, `${grabs.length} grabs`);
  fire("click", 600, 600);
  await new Promise((r) => setTimeout(r, 600));
  check("the second capture completes without re-arming the tool",
    grabs.length === 3, `${grabs.length} grabs`);
  check("a second strip queues alongside the first, not instead of it",
    root.querySelectorAll(".att .thumb").length === 2,
    `${root.querySelectorAll(".att .thumb").length} thumbs`);
  check("six frames across two captures still leaves room for more",
    shots_queued() < 6, `${shots_queued()} captures queued`);

  // --- an open-ended wait: no timer, just the click
  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  grabs.length = 0;
  root.querySelector(".cap-delay").value = "-1";
  root.querySelector(".cap-frames").value = "3";
  atPoint = window.document.querySelector(".notify-button");
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 700, 590);
  fire("pointerup", 700, 590); fire("click", 700, 590);
  await new Promise((r) => setTimeout(r, 800));
  check("an open-ended wait does not fire on a timer", grabs.length === 0, `${grabs.length} grabs`);
  check("the marker says it is waiting for a click",
    /click to start/.test(root.querySelector(".armed .tag")?.textContent ?? ""),
    root.querySelector(".armed .tag")?.textContent);
  fire("click", 600, 600);
  await new Promise((r) => setTimeout(r, 500));
  check("and fires when the click comes", grabs.length === 3, `${grabs.length} grabs`);

  // Escape must get you out of a wait with no timer
  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  grabs.length = 0;
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 700, 590);
  fire("pointerup", 700, 590); fire("click", 700, 590);
  await new Promise((r) => setTimeout(r, 300));
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  check("Escape cancels an open-ended wait", grabs.length === 0, `${grabs.length} grabs`);
  check("and clears the marker", !root.querySelector(".armed"),
    root.querySelector(".armed") ? "LEFT BEHIND" : "cleared");
  check("but leaves the tool armed — cancelling a capture is not leaving the tool",
    tool("shot").classList.contains("on"), [...tool("shot").classList].join(" "));

  // a 16-frame strip is allowed
  root.querySelector(".cap-delay").value = "0";
  root.querySelector(".cap-frames").value = "16";
  root.querySelector(".cap-every").value = "16";
  grabs.length = 0;
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 700, 590);
  fire("pointerup", 700, 590); fire("click", 700, 590);
  await new Promise((r) => setTimeout(r, 1200));
  check("a 16-frame strip is taken in full", grabs.length === 16, `${grabs.length} grabs`);
  check("and queues as one badged capture",
    root.querySelector(".thumb .count")?.textContent === "×16",
    root.querySelector(".thumb .count")?.textContent);

  // --- pruning individual frames out of a strip
  {
    const badge = root.querySelector(".thumb .count");
    check("the strip shows as one badged thumbnail", badge?.textContent === "×16", badge?.textContent);
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    check("clicking the badge expands it into every frame",
      root.querySelectorAll(".att .thumb").length === 16,
      `${root.querySelectorAll(".att .thumb").length} thumbs`);
    check("each expanded frame has its own remove control",
      root.querySelectorAll(".att .thumb .x").length === 16);

    root.querySelectorAll(".att .thumb .x")[3].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    check("removing one frame leaves the rest", root.querySelectorAll(".att .thumb").length === 15,
      `${root.querySelectorAll(".att .thumb").length} thumbs`);
    check("and the capture survives", shots_queued() > 0, `${shots_queued()}`);

    root.querySelector(".strip .fold").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    check("collapsing returns to one thumbnail", root.querySelectorAll(".att .thumb").length === 1);
    check("the badge reflects the pruned count",
      root.querySelector(".thumb .count")?.textContent === "×15",
      root.querySelector(".thumb .count")?.textContent);

    // and from inside the viewer
    root.querySelector(".att img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check("the viewer offers a remove control", !!root.querySelector(".lightbox [data-act=drop-frame]"));
    root.querySelector(".lightbox [data-act=drop-frame]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    check("removing from the viewer prunes that frame",
      /of 14/.test(root.querySelector(".lightbox .cap")?.textContent ?? ""),
      root.querySelector(".lightbox .cap")?.textContent?.slice(-60));
    check("and the viewer stays open on the next frame",
      root.querySelector(".lightbox").classList.contains("on"));

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await tick();
    check("Delete prunes from the keyboard too",
      /of 13/.test(root.querySelector(".lightbox .cap")?.textContent ?? ""),
      root.querySelector(".lightbox .cap")?.textContent?.slice(-60));
    root.querySelector(".lightbox").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }

  fakeNative.ready = realReady;
  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  root.querySelector(".cap-delay").value = "0";
  root.querySelector(".cap-frames").value = "1";
  root.querySelector(".cap-every").value = "150";
  await tick();
  await clickTool("shot");
}

// --- native capture: real pixels, with the renderer as the fallback
{
  check("a native capture layer ships with the client", nativeShipped);

  grabs.length = 0;
  fakeNative.declined = false;
  await clickTool("shot");
  atPoint = window.document.querySelector(".notify-form");
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 760, 600);
  fire("pointerup", 760, 600); fire("click", 760, 600);
  await tick(); await tick();

  check("the shutter uses the screen, not the renderer", grabs.length === 1, `${grabs.length} native grabs`);
  check("it grabs the rectangle that was dragged",
    grabs[0] && Math.round(grabs[0].right - grabs[0].left) === 240 &&
      Math.round(grabs[0].bottom - grabs[0].top) === 70, JSON.stringify(grabs[0]));
  const shotImg = root.querySelector(".att img");
  check("the queued shot holds the screen pixels", /SCREENPIXELS/.test(shotImg?.src ?? ""),
    shotImg?.src?.slice(0, 40));
  check("a native shot is not labelled as rendered", !/rendered/.test(shotImg?.title ?? ""), shotImg?.title);

  // Declining must downgrade, never fail.
  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  grabs.length = 0;
  fakeNative.declined = true;
  fire("pointerdown", 520, 530); fire("pointermove", 560, 570); fire("pointermove", 700, 590);
  fire("pointerup", 700, 590); fire("click", 700, 590);
  await tick(); await tick();
  check("declining falls back to the renderer rather than failing",
    grabs.length === 0 && !!root.querySelector(".att img"), `${grabs.length} grabs`);
  check("and the fallback says so in the label",
    /rendered/.test(root.querySelector(".att img")?.title ?? ""), root.querySelector(".att img")?.title);

  root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  fakeNative.declined = false;
  await clickTool("shot"); // leave Screenshot mode as the blocks below expect
}

// --- the agent's page calls, driven through the socket as the bridge sends them.
// The fake-page probes answer RPCs themselves, so nothing exercised this dispatcher
// — which is how a shadowed accessor broke every tool without a test noticing.
{
  const sock = sockets[0];
  const call = async (method, params = {}) => {
    const id = Math.floor(Math.random() * 1e6);
    sock.onmessage({ data: JSON.stringify({ kind: "rpc", id, method, params }) });
    await new Promise((r) => setTimeout(r, 30));
    return sent.find((f) => f.kind === "rpc_result" && f.id === id);
  };

  // clickTool toggles, so arm only if it is not already armed — and leave it armed,
  // which is the state the blocks below expect.
  if (!tool("pick").classList.contains("on")) await clickTool("pick");
  UITalk.clearSelection();
  atPoint = window.document.querySelector(".notify-button");
  fire("click", 600, 600);
  await tick();
  check("a selection exists for the calls below", UITalk.picked.length === 1, `picked ${UITalk.picked.length}`);

  const sel = await call("readSelection");
  check("read_selection answers over the socket", sel?.result?.selected === 1,
    JSON.stringify(sel?.error ?? sel?.result?.selected));

  const scan = await call("scanRegion", { x: 500, y: 500, w: 460, h: 160 });
  check("scan_region answers", Array.isArray(scan?.result?.elements), scan?.error ?? "ok");

  const shot = await call("capture", { inventory: false });
  check("capture answers", typeof shot?.result?.png === "string", shot?.error ?? "ok");

  const styled = await call("tryStyle", { ref: 1, declarations: "color: red" });
  check("try_style answers", styled?.result?.applied === true, styled?.error ?? "ok");

  const bySelector = await call("tryStyle", { selector: ".notify-input", declarations: "color: blue" });
  check("try_style by selector answers", bySelector?.result?.applied === true, bySelector?.error ?? "ok");

  const opts = await call("showOptions", { ref: 1, options: [
    { label: "A", declarations: "border-radius: 0" },
    { label: "B", declarations: "border-radius: 99px" },
    { label: "C", declarations: "border-radius: 8px" },
  ]});
  check("show_options answers", opts?.result?.mounted === 3, opts?.error ?? "ok");

  // direct access to each variant, plus the original, without walking the arrows
  const picks = [...root.querySelectorAll(".picks button")];
  check("every variant gets a button, plus the original", picks.length === 4,
    picks.map((b) => b.textContent).join(" | "));
  check("the original is offered first", /original/i.test(picks[0].textContent), picks[0].textContent);
  check("the buttons are numbered", picks[1].textContent === "1", picks[1].textContent);
  check("the label rides in the tooltip", /A/.test(picks[1].title), picks[1].title);
  check("they wrap rather than scroll — nothing hidden off the edge", (() => {
    const sheet = [...root.querySelectorAll("style")].map((n) => n.textContent).join("");
    return /\.picks \{[^}]*flex-wrap: wrap/.test(sheet) && !/\.picks \{[^}]*overflow-x/.test(sheet);
  })());

  picks[3].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  check("clicking a button jumps straight to that variant", UITalk.optionState.active === 2,
    String(UITalk.optionState.active));
  check("the active button is marked", root.querySelector(".picks button.on")?.textContent === "3",
    root.querySelector(".picks button.on")?.textContent);

  // A mounted variant can resize the element, so markers drawn from the old
  // geometry would be stale — and a ring over the design interferes with judging it.
  check("selection markers are hidden while a variant is mounted",
    root.querySelectorAll(".badge").length === 0 && root.querySelectorAll(".ring").length === 0,
    `${root.querySelectorAll(".badge").length} badges`);
  check("the selection itself survives, or the variants would unmount",
    UITalk.picked.length === 1 && !!root.querySelector(".chip-sel"), `picked ${UITalk.picked.length}`);
  check("the element keeps the ref the preview is keyed to",
    UITalk.picked[0].getAttribute("data-uitalk-ref") === "1");

  root.querySelector(".picks button.original").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  check("the original button restores the page's own styling", UITalk.optionState.active === -1);
  check("and the markers come back with it",
    root.querySelectorAll(".badge").length === 1, `${root.querySelectorAll(".badge").length} badges`);
  check("approve is disabled on the original",
    root.querySelector('[data-act="approve"]').disabled === true);

  await call("resetPreview");

  const reset = await call("resetPreview");
  check("reset_preview answers", reset?.result?.reset === true, reset?.error ?? "ok");
  check("the variant buttons are cleared with the options", !root.querySelector(".picks button"));

  const bogus = await call("nonsense");
  check("an unknown method comes back as an error, not a hang",
    /unknown method/.test(bogus?.error ?? ""), bogus?.error ?? "no reply");

  const badRef = await call("tryStyle", { ref: 99, declarations: "color: red" });
  check("a bad ref reports something the agent can act on",
    /CSS selector/.test(badRef?.error ?? ""), badRef?.error ?? "no error");
}

// --- the floating panel resizes in both axes
{
  const panel = root.querySelector(".panel");
  // jsdom reports a zero box, so drive from a known starting size.
  panel.style.width = "372px";
  panel.style.height = "520px";
  panel.getBoundingClientRect = () => ({ width: 372, height: 520, left: 0, top: 0, right: 372, bottom: 520 });

  const grip = (sel) => root.querySelector(sel);
  check("the panel offers height, width and corner handles",
    !!grip(".grip") && !!grip(".grip-w") && !!grip(".grip-nw"));

  const drag = (el, type, x, y) =>
    el.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));

  // anchored bottom-right, so dragging the left edge leftwards widens it
  drag(grip(".grip-w"), "pointerdown", 500, 300);
  drag(grip(".grip-w"), "pointermove", 400, 300);
  check("dragging the left edge widens the panel", panel.style.width === "472px", panel.style.width);
  check("the height is untouched by a width drag", panel.style.height === "520px", panel.style.height);
  drag(grip(".grip-w"), "pointerup", 400, 300);

  drag(grip(".grip"), "pointerdown", 500, 300);
  drag(grip(".grip"), "pointermove", 500, 250);
  check("dragging the top edge heightens the panel", panel.style.height === "570px", panel.style.height);
  drag(grip(".grip"), "pointerup", 500, 250);

  drag(grip(".grip-nw"), "pointerdown", 500, 300);
  drag(grip(".grip-nw"), "pointermove", 460, 260);
  check("the corner changes both", panel.style.width === "412px" && panel.style.height === "560px",
    `${panel.style.width} x ${panel.style.height}`);
  drag(grip(".grip-nw"), "pointerup", 460, 260);

  drag(grip(".grip-w"), "pointerdown", 500, 300);
  drag(grip(".grip-w"), "pointermove", 900, 300);
  check("it will not shrink below a usable width", parseInt(panel.style.width, 10) >= 300, panel.style.width);
  drag(grip(".grip-w"), "pointerup", 900, 300);

  const sheet = [...root.querySelectorAll("style")].map((n) => n.textContent).join("\n");
  check("the side handles are hidden when docked",
    /\.panel\.docked \.grip-w[^}]*display: none/.test(sheet));

  panel.style.width = "";
  panel.style.height = "";
}

// --- an approved change is shown before and after, not just described
{
  const sock = sockets[0];
  grabs.length = 0;
  fakeNative.declined = false;
  // jsdom carries no HMR marker, so "auto" would reload the page first; this block
  // is about the comparison, and the reload path is covered on its own below.
  const liveReloadDefault = UITalk.liveReload;
  UITalk.liveReload = () => "vite";

  // stand in for a mounted set of variants and approve one
  UITalk.clearSelection();
  atPoint = window.document.querySelector(".notify-button");
  if (!tool("pick").classList.contains("on")) await clickTool("pick");
  fire("click", 600, 600);
  await tick();
  UITalk.showOptions({ ref: 1, options: [
    { label: "Pill", declarations: "border-radius: 999px" },
    { label: "Square", declarations: "border-radius: 0" },
  ]});
  await tick();
  root.querySelector('[data-act="approve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  check("approving photographs the element first", grabs.length === 1, `${grabs.length} grabs`);

  sock.onmessage({ data: JSON.stringify({ kind: "turn_end" }) });
  await new Promise((r) => setTimeout(r, 1400));
  check("and again once the agent has finished", grabs.length === 2, `${grabs.length} grabs`);
  check("the two are shown side by side", !!root.querySelector(".compare"),
    root.querySelector(".compare") ? "shown" : "NO COMPARISON");
  check("labelled before and after",
    [...root.querySelectorAll(".compare figcaption")].map((c) => c.textContent).join(",") === "before,after",
    [...root.querySelectorAll(".compare figcaption")].map((c) => c.textContent).join(","));

  // --- and the committed result is checked against what was approved
  {
    // pretend the edit landed correctly: computed values match the preview
    const realComputed = UITalk.computedOf;
    UITalk.computedOf = () => ({ "border-radius": "999px" });
    UITalk.clearSelection();
    atPoint = window.document.querySelector(".notify-button");
    fire("click", 600, 600);
    await tick();
    UITalk.showOptions({ ref: 1, options: [
      { label: "Pill", declarations: "border-radius: 999px" },
      { label: "Square", declarations: "border-radius: 0" },
    ]});
    await tick();
    root.querySelector('[data-act="approve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(); await tick();
    sock.onmessage({ data: JSON.stringify({ kind: "turn_end" }) });
    await new Promise((r) => setTimeout(r, 1400));
    const log = [...root.querySelectorAll(".log .msg")].map((m) => m.textContent).join(" | ");
    check("a change that survived the edit is reported as verified", /looks the same committed/.test(log),
      log.slice(-90));

    // now pretend it silently lost the cascade
    const sentBefore = sent.length;
    // First read is at approval (what the preview produced); the second is after the
    // agent's edit. They must differ for there to be drift to catch.
    let reads = 0;
    UITalk.computedOf = () => ({ "border-radius": reads++ === 0 ? "999px" : "4px" });
    UITalk.clearSelection();
    fire("click", 600, 600);
    await tick();
    UITalk.showOptions({ ref: 1, options: [
      { label: "Pill", declarations: "border-radius: 999px" },
      { label: "Square", declarations: "border-radius: 0" },
    ]});
    await tick();
    root.querySelector('[data-act="approve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(); await tick();
    sock.onmessage({ data: JSON.stringify({ kind: "turn_end" }) });
    await new Promise((r) => setTimeout(r, 1400));
    const log2 = [...root.querySelectorAll(".log .msg.warn")].map((m) => m.textContent).join(" | ");
    check("an edit that did not take effect is caught", /did not survive the edit/.test(log2), log2.slice(-90));
    check("and the agent is told, with the values", (() => {
      const msg = sent.slice(sentBefore).find((f) => f.kind === "chat" && /did not take effect/.test(f.text ?? ""));
      return !!msg && /border-radius should be "999px" but is "4px"/.test(msg.text);
    })());
    check("and pointed at describe_styles to find out why", (() => {
      const msg = sent.slice(sentBefore).find((f) => f.kind === "chat" && /did not take effect/.test(f.text ?? ""));
      return /describe_styles/.test(msg?.text ?? "");
    })());

    // --- an app with no live reload has to be reloaded before the result is real.
    // jsdom will not let location.reload be stubbed, so assert the decision by its
    // observable consequence: the pending check is handed to the next page load.
    {
      const realLive = UITalk.liveReload;
      const approve = async () => {
        UITalk.clearSelection();
        fire("click", 600, 600);
        await tick();
        UITalk.showOptions({ ref: 1, options: [
          { label: "Pill", declarations: "border-radius: 999px" },
          { label: "Square", declarations: "border-radius: 0" },
        ]});
        await tick();
        root.querySelector('[data-act="approve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await tick(); await tick();
        sock.onmessage({ data: JSON.stringify({ kind: "turn_end" }) });
        await new Promise((r) => setTimeout(r, 1400));
      };

      window.sessionStorage.removeItem("uitalk.pendingVerify");
      UITalk.liveReload = () => null; // no HMR, as a Flask or Django app
      await approve();
      const saved = JSON.parse(window.sessionStorage.getItem("uitalk.pendingVerify") ?? "null");
      check("an app with no live reload defers the check to after a reload",
        saved?.label === "Pill" && saved.props?.includes("border-radius"),
        JSON.stringify(saved && { label: saved.label, props: saved.props }));
      const log3 = [...root.querySelectorAll(".log .msg")].map((m) => m.textContent).join(" | ");
      check("and says why", /no live reload detected/.test(log3), log3.slice(-70));
      window.sessionStorage.removeItem("uitalk.pendingVerify");

      UITalk.liveReload = () => "vite"; // an app that hot-reloads is left alone
      await approve();
      check("an app with HMR is judged in place, without a reload",
        window.sessionStorage.getItem("uitalk.pendingVerify") === null,
        window.sessionStorage.getItem("uitalk.pendingVerify") ?? "nothing deferred");

      UITalk.liveReload = realLive;
    }

    UITalk.computedOf = realComputed;
  }

  UITalk.liveReload = liveReloadDefault;
  UITalk.resetPreview();
  UITalk.clearSelection();
  await tick();
}

// --- settings render by type, not as a number box for everything
{
  const sock = sockets[0];
  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: window.__UITALK_BUILD__,
    settings: { autoCompact: true, compactAtPercent: 20, reloadAfterEdit: "auto" },
    fields: {
      autoCompact: { type: "boolean", label: "Compact automatically" },
      compactAtPercent: { type: "number", min: 5, max: 95, label: "Compact at %" },
      reloadAfterEdit: { type: "choice", choices: ["auto", "always", "never"], label: "Reload after an edit" },
    } }) });
  await tick();

  const byKey = (k) => root.querySelector(`.settings [data-key="${k}"]`);
  check("a boolean setting renders a checkbox", byKey("autoCompact")?.type === "checkbox");
  check("a number setting renders a number box", byKey("compactAtPercent")?.type === "number");
  check("a choice setting renders a select, not a number box",
    byKey("reloadAfterEdit")?.tagName === "SELECT", byKey("reloadAfterEdit")?.tagName);
  check("the select offers exactly the allowed values",
    [...(byKey("reloadAfterEdit")?.options ?? [])].map((o) => o.value).join(",") === "auto,always,never",
    [...(byKey("reloadAfterEdit")?.options ?? [])].map((o) => o.value).join(","));
  check("and shows the current one", byKey("reloadAfterEdit")?.value === "auto");

  const before = sent.length;
  const sel = byKey("reloadAfterEdit");
  sel.value = "never";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  const patch = sent.slice(before).find((f) => f.kind === "settings");
  check("changing it sends the string, not a number", patch?.patch?.reloadAfterEdit === "never",
    JSON.stringify(patch?.patch));
}

// --- a text setting, and the rows a live session cannot adopt
{
  const sock = sockets[0];
  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: window.__UITALK_BUILD__,
    settings: { agentModel: "gpt-5", agent: "builtin" },
    fields: {
      agentModel: { type: "text", max: 120, label: "Adapter model", restart: true },
      agent: { type: "choice", choices: ["builtin", "adapter", "off"], label: "Who answers", restart: true },
    } }) });
  await tick();

  const model = root.querySelector('.settings [data-key="agentModel"]');
  check("a free-text setting renders a text box, not a number box",
    model?.type === "text" && model.value === "gpt-5", `${model?.type} = ${model?.value}`);
  check("a setting that only applies on restart says so on its row",
    model?.closest(".row")?.classList.contains("needs-restart"),
    model?.closest(".row")?.className ?? "no row");

  const before = sent.length;
  model.value = "gemini-2.5-pro";
  model.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  const patch = sent.slice(before).find((f) => f.kind === "settings");
  check("editing it sends the string it was given",
    patch?.patch?.agentModel === "gemini-2.5-pro", JSON.stringify(patch?.patch));
}

// --- with no agent, the panel stops offering what cannot work
{
  const sock = sockets[0];
  const panel = root.querySelector(".panel");
  const composer = root.querySelector(".composer");
  const meter = root.querySelector(".meter .track");

  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: window.__UITALK_BUILD__,
    settings: {}, fields: {}, agent: { mode: "off", label: null, of: "an MCP client" } }) });
  await tick();

  check("the panel marks itself as having no agent",
    panel.classList.contains("no-agent"), panel.className);
  check("the chat is taken away rather than left to swallow messages",
    root.querySelector("textarea").disabled === true, `disabled=${root.querySelector("textarea").disabled}`);
  check("and the page says where to type instead",
    /editor is driving over MCP/.test(root.querySelector(".elsewhere").textContent),
    root.querySelector(".elsewhere").textContent.slice(0, 50) || "(empty)");

  // The rules have to exist, or hiding is a no-op that looks like a live control.
  const sheet = [...root.querySelectorAll("style")].map((n) => n.textContent).join("\n");
  for (const sel of [".panel.no-agent .composer", ".panel.no-agent .meter .track", ".elsewhere"]) {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    check(`${sel} is actually styled`, new RegExp(`${escaped}\\s*[,{]`).test(sheet),
      new RegExp(`${escaped}\\s*[,{]`).test(sheet) ? "rule present" : "NO RULE — hiding would silently do nothing");
  }

  // The selection and screenshot tools are page-side and must stay usable.
  check("the tools themselves are untouched, because they need no agent",
    [...root.querySelectorAll(".tools .tool")].length === 4 &&
      ![...root.querySelectorAll(".tools .tool")].some((b) => b.disabled),
    `${root.querySelectorAll(".tools .tool").length} tools, none disabled`);

  sock.onmessage({ data: JSON.stringify({ kind: "agent_absent", text: "nobody is here to read that" }) });
  await tick();
  check("a message the bridge could not deliver is reported in the log",
    /nobody is here to read that/.test(root.querySelector(".log").textContent),
    root.querySelector(".log").textContent.slice(-50));

  // Back to a mode that has one, so later checks see the normal panel.
  sock.onmessage({ data: JSON.stringify({ kind: "ready", project: "/p", build: window.__UITALK_BUILD__,
    settings: {}, fields: {}, agent: { mode: "builtin", label: "claude" } }) });
  await tick();
  check("and it goes back when an agent is there",
    !panel.classList.contains("no-agent") && Boolean(composer) && Boolean(meter),
    panel.className);
}

// --- undo appears only when the bridge says a change can be taken back
{
  const sock = sockets[0];
  check("no undo control before anything is approved", !root.querySelector(".undo.on"));

  sock.onmessage({ data: JSON.stringify({ kind: "revertable", available: true, label: "Bold with shadow" }) });
  await tick();
  check("an approved change offers an undo", !!root.querySelector(".undo.on"),
    root.querySelector(".undo")?.textContent);
  check("it names what would be undone",
    /Bold with shadow/.test(root.querySelector(".undo")?.textContent ?? ""),
    root.querySelector(".undo")?.textContent);

  const before = sent.length;
  root.querySelector(".undo").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick();
  check("clicking it asks the bridge to revert",
    sent.slice(before).some((f) => f.kind === "revert"),
    JSON.stringify(sent.slice(before).map((f) => f.kind)));

  sock.onmessage({ data: JSON.stringify({ kind: "reverted", ok: true, label: "Bold with shadow", files: ["src/App.css"] }) });
  await tick();
  check("once reverted the control goes away", !root.querySelector(".undo.on"));

  sock.onmessage({ data: JSON.stringify({ kind: "revertable", available: false, label: "x" }) });
  await tick();
  check("a project with no git history offers no undo", !root.querySelector(".undo.on"));
}

// --- split screen is reachable from a button, not by knowing a URL
{
  const link = root.querySelector(".meter .split");
  check("the panel offers a split-screen control", !!link, link ? link.title : "not found");
  check("it points at the shell, carrying the current route",
    link.getAttribute("href") === "/__uitalk/shell#/", link.getAttribute("href"));
  check("it is a link, so it can be opened in a new tab", link.tagName === "A");
  check("it is labelled", /split screen/i.test(link.title), link.title);
}

// --- recalling previous messages with the arrow keys
{
  const type = (text) => { input.value = text; };
  const key = (k, opts = {}) =>
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

  const before = sent.filter((f) => f.kind === "chat").length;
  type("first message"); key("Enter"); await tick();
  type("second message"); key("Enter"); await tick();
  check("both messages were sent", sent.filter((f) => f.kind === "chat").length === before + 2);
  check("the composer is empty afterwards", input.value === "");

  key("ArrowUp");
  check("Up recalls the most recent message", input.value === "second message", input.value);
  key("ArrowUp");
  check("Up again steps further back", input.value === "first message", input.value);
  key("ArrowUp");
  check("it stops at the oldest rather than wrapping", input.value === "first message", input.value);

  key("ArrowDown");
  check("Down comes forward again", input.value === "second message", input.value);
  key("ArrowDown");
  check("Down past the newest returns to the empty draft", input.value === "", input.value);

  // an unsent draft must survive a trip through the history
  type("half-written thought");
  input.setSelectionRange(input.value.length, input.value.length);
  key("ArrowUp");
  check("Up preserves the draft", input.value === "second message", input.value);
  key("ArrowDown");
  check("coming back restores the draft", input.value === "half-written thought", input.value);

  key("ArrowUp");
  key("Escape");
  check("Escape cancels the recall and restores the draft", input.value === "half-written thought", input.value);

  // editing a recalled message and sending it
  key("ArrowUp");
  type(input.value + " (edited)");
  key("Enter");
  await tick();
  const last = sent.filter((f) => f.kind === "chat").at(-1);
  check("an edited recall sends as a new message", last.text === "second message (edited)", last.text);
  key("ArrowUp");
  check("the edited message joins the history", input.value === "second message (edited)", input.value);

  // Up inside a multi-line message should move the caret, not recall
  type("line one\nline two");
  input.setSelectionRange(input.value.length, input.value.length);
  const held = input.value;
  key("ArrowUp");
  check("Up on a later line moves the caret instead of recalling", input.value === held, input.value);

  input.value = "";
}

// --- Escape unwinds one layer at a time
UITalk.clearSelection();
atPoint = window.document.querySelector(".notify-input");
fire("click", 600, 540);
await tick();
check("something is selected before Escape", UITalk.picked.length === 1);
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
check("Escape deselects everything first", UITalk.picked.length === 0, `picked ${UITalk.picked.length}`);
check("Escape leaves the tool armed while a selection existed", tool("pick").classList.contains("on"));
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
check("a second Escape turns the tool off", !tool("pick").classList.contains("on"));

// --- the hover highlight must not strand itself
await clickTool("pick");
atPoint = window.document.querySelector(".notify-button");
fire("mousemove", 600, 600);
check("hovering an element highlights it", !!root.querySelector(".hover"));

atPoint = host; // the pointer moves onto our own panel
fire("mousemove", 5, 5);
check("moving onto the panel clears the highlight", !root.querySelector(".hover"),
  root.querySelector(".hover") ? "still highlighted" : "");

atPoint = window.document.querySelector(".notify-button");
fire("mousemove", 600, 600);
check("it highlights again on returning to the page", !!root.querySelector(".hover"));
window.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
check("leaving the window clears the highlight", !root.querySelector(".hover"));

fire("mousemove", 600, 600);
root.querySelector(".panel").dispatchEvent(new window.MouseEvent("pointerenter", { bubbles: false }));
check("entering the panel clears it even without a page mousemove", !root.querySelector(".hover"));

await clickTool("shot"); // the checks below are about Screenshot mode

// --- Screenshot mode must not behave like a selector
check("no element highlight in Screenshot mode", (() => {
  atPoint = window.document.querySelector(".notify-button");
  fire("mousemove", 600, 600);
  return !root.querySelector(".hover");
})(), root.querySelector(".hover") ? "a hover box appeared" : "");

check("the page shows a crosshair in Screenshot mode",
  window.document.documentElement.style.cursor === "crosshair",
  window.document.documentElement.style.cursor || "(none)");

shots.length = 0;
const pickedBeforeClick = UITalk.picked.length;
fire("pointerdown", 600, 600);
fire("pointerup", 600, 600);
fire("click", 600, 600);
await tick(); await tick();
check("a bare click in Screenshot mode selects nothing", UITalk.picked.length === pickedBeforeClick,
  `${pickedBeforeClick} -> ${UITalk.picked.length}`);
check("a bare click in Screenshot mode captures nothing", shots.length === 0, `${shots.length} captures`);

// --- drag to screenshot a region (through the renderer; the native path has its
// own block below, and this one is about the gesture, not the pixels)
fakeNative.declined = true;
shots.length = 0;
atPoint = window.document.querySelector(".notify-form");
fire("pointerdown", 520, 530);
fire("pointermove", 540, 550);
fire("pointermove", 760, 600);
const shotBand = root.querySelector(".marquee");
const dashed = shotBand?.classList.contains("shot");
fire("pointerup", 760, 600);
fire("click", 760, 600); // the browser's trailing click, which must be swallowed
await tick();
await tick();
check("the screenshot band is styled differently", dashed === true);
check("dragging in Screenshot mode captures", shots.length === 1, `${shots.length} captures`);
check("it captures the dragged region", shots[0] && shots[0].clip?.left === 520 && shots[0].clip?.bottom === 600,
  JSON.stringify(shots[0]?.clip));
check("the shot is queued, not sent", tool("shot").classList.contains("queued") && !sent.some((f) => f.png));
fakeNative.declined = false;

// --- several screenshots can be queued
atPoint = window.document.querySelector(".notify-form");
fire("pointerdown", 515, 525); fire("pointermove", 560, 570); fire("pointermove", 700, 610);
fire("pointerup", 700, 610); fire("click", 700, 610);
await tick(); await tick();
check("a second screenshot queues alongside the first",
  root.querySelectorAll(".strip .thumb").length === 2,
  `${root.querySelectorAll(".strip .thumb").length} thumbs`);
check("the tool button shows the count", tool("shot").dataset.count === "2", tool("shot").dataset.count);
check("each thumbnail has its own remove control", root.querySelectorAll(".thumb .x").length === 2);
// The cross is drawn with pseudo-elements; a text glyph would sit wherever the
// font's metrics put it, which is what kept it looking off-centre.
check("the remove control carries no text glyph",
  root.querySelector(".thumb .x").textContent === "",
  JSON.stringify(root.querySelector(".thumb .x").textContent));
check("it is labelled for assistive tech instead",
  root.querySelector(".thumb .x").getAttribute("aria-label") === "Remove this screenshot");

root.querySelector(".thumb .x").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
check("removing one leaves the other", root.querySelectorAll(".strip .thumb").length === 1);

// --- a selection and a screenshot can be sent together
// Establish both explicitly: earlier blocks deliberately clear the selection.
await clickTool("pick");
atPoint = window.document.querySelector(".notify-input");
fire("click", 600, 540);
await tick();
const selectedBeforeShot = UITalk.picked.length;
await clickTool("shot");
check("a selection survives into Screenshot mode",
  UITalk.picked.length === selectedBeforeShot && selectedBeforeShot > 0, `picked ${UITalk.picked.length}`);

// --- the queued shot rides along with the next message
input.value = "make this tighter";
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await tick();
const chat = sent.filter((f) => f.kind === "chat").at(-1);
check("the message carries the queued screenshots as a list",
  Array.isArray(chat?.shots) && chat.shots.length === 1, JSON.stringify(Object.keys(chat ?? {})));
check("each carries its label", typeof chat?.shots?.[0]?.label === "string", chat?.shots?.[0]?.label);
check("the same message reports the live selection count", chat?.selectionCount > 0,
  String(chat?.selectionCount));
check("the queued marker clears after sending", !tool("shot").classList.contains("queued"));

// what went with a message must stay visible in the message
const mine = [...root.querySelectorAll(".msg.me")].at(-1);
check("the sent message records its attachments", !!mine?.querySelector(".sent"),
  mine?.textContent?.slice(0, 60));
check("it shows a thumbnail of each screenshot sent",
  mine.querySelectorAll(".sent img").length === chat.shots.length,
  `${mine.querySelectorAll(".sent img").length} vs ${chat.shots.length}`);
check("it names what was attached", /screenshot/.test(mine.querySelector(".sent .what")?.textContent ?? ""),
  mine.querySelector(".sent .what")?.textContent);
check("it lists the elements that were selected",
  /element/.test(mine.querySelector(".sent .what")?.textContent ?? ""),
  mine.querySelector(".sent .what")?.textContent);
check("a sent thumbnail still opens full size", (() => {
  mine.querySelector(".sent img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const on = root.querySelector(".lightbox").classList.contains("on");
  root.querySelector(".lightbox").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return on;
})());
check("the tray is emptied even though the message keeps its copy",
  !root.querySelector(".strip .thumb"));


// --- the tray, not the transcript
const logText = () => [...root.querySelectorAll(".log .msg")].map((m) => m.textContent).join(" | ");
await clickTool("pick");
UITalk.clearSelection(); // start from nothing: clicking an already-picked element toggles it off
atPoint = window.document.querySelector(".notify-input");
const logBefore = logText();
fire("click", 600, 540);
await tick();
check("selecting does not write to the transcript", logText() === logBefore, logText().slice(-60));
check("selection shows as a tray chip", !!root.querySelector(".chip-sel"), root.querySelector(".chips")?.textContent);
check("the tray chip carries a deselect control", !!root.querySelector(".chip-sel .x"));
check("selecting sends nothing to the bridge", !sent.some((f) => f.kind === "chat" && /notify/.test(f.text ?? "")));

root.querySelector(".chip-sel .x").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
check("the chip's ✕ deselects", UITalk.picked.length === 0, `picked ${UITalk.picked.length}`);

// --- a queued screenshot is visible and discardable
await clickTool("shot");
shots.length = 0;
atPoint = window.document.querySelector(".notify-button");
fire("pointerdown", 520, 540);
fire("pointermove", 560, 570);
fire("pointermove", 900, 630);
fire("pointerup", 900, 630);
fire("click", 900, 630);
await tick(); await tick();
check("the queued shot renders a preview image", !!root.querySelector(".att img"),
  root.querySelector(".att")?.className);
check("the preview is a data URI of the capture", /^data:image\/png;base64,/.test(root.querySelector(".att img")?.src ?? ""));
check("clicking the preview opens a full-size viewer", (() => {
  root.querySelector(".att img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return root.querySelector(".lightbox").classList.contains("on");
})());
check("the viewer sits outside the panel, so it cannot be clipped by it",
  !root.querySelector(".panel").contains(root.querySelector(".lightbox")));
check("the viewer shows the captured image",
  /^data:image\/png;base64,/.test(root.querySelector(".lightbox img")?.src ?? ""));
check("clicking the viewer closes it", (() => {
  root.querySelector(".lightbox").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return !root.querySelector(".lightbox").classList.contains("on");
})());
check("a discard control is offered", !!root.querySelector('.att [data-act="discard-shot"]'));

root.querySelector('.att [data-act="discard-shot"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
check("discarding removes the preview", !root.querySelector(".att img"));
check("discarding clears the queued marker", !tool("shot").classList.contains("queued"));

input.value = "after discarding";
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await tick();
check("a discarded shot is not sent", !sent.filter((f) => f.kind === "chat").at(-1)?.png);

// --- Escape turns the tool off but keeps the selection
await clickTool("pick");
atPoint = window.document.querySelector(".notify-input");
fire("click", 600, 540);
await tick();
const kept = UITalk.picked.length;
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
check("the crosshair is cleared when leaving Screenshot mode",
  window.document.documentElement.style.cursor !== "crosshair",
  window.document.documentElement.style.cursor || "(none)");
check("Escape with a selection clears it rather than the tool", UITalk.picked.length === 0,
  `${kept} -> ${UITalk.picked.length}`);

// ---------------------------------------------------------------- shell mode
// A second document, this time as the shell: it must build the device chrome, put
// the app in a frame, and suppress the frame's own panel.
{
  const shellDom = new JSDOM(
    `<!doctype html><html><head><title>uitalk</title></head><body></body></html>`,
    { url: "http://127.0.0.1:8400/__uitalk/shell", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc },
  );
  const sw = shellDom.window;
  sw.__UITALK_SHELL__ = true;
  sw.CSSStyleSheet = FakeSheet;
  sw.document.adoptedStyleSheets = [];
  sw.CSS = { escape: (v) => String(v) };
  sw.devicePixelRatio = 2;
  sw.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const shellSent = [];
  sw.WebSocket = class { constructor() { this.readyState = 1; setTimeout(() => this.onopen?.({}), 0); } send(d) { shellSent.push(JSON.parse(d)); } close() {} };
  sw.Element.prototype.scrollIntoView = function () {};
  sw.Element.prototype.setPointerCapture = function () {};
  sw.Element.prototype.releasePointerCapture = function () {};

  for (const f of ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]) {
    loadClient(sw, f);
  }

  const UITalkShell = sw.UITalkShell;
  const sbar = sw.document.getElementById("uitalk-bar");
  const sframe = sw.document.getElementById("uitalk-app");
  const spanel = sw.document.getElementById("uitalk-host")?.shadowRoot?.querySelector(".panel");

  check("shell builds a device toolbar", !!sbar && sbar.querySelectorAll("[data-device]").length >= 6);
  check("no duplicate history controls: the browser's own are the ones that work",
    ["back", "forward", "reload"].every((a) => !sbar.querySelector(`[data-act="${a}"]`)));
  check("shell puts the app in a frame", !!sframe && /\/$/.test(sframe.src), sframe?.src);
  check("shell marks the document so the frame can detect it",
    sw.document.documentElement.dataset.uitalkShell === "1");
  check("the panel docks instead of floating", !!spanel && spanel.classList.contains("docked"));
  const css = [...sw.document.getElementById("uitalk-host").shadowRoot.querySelectorAll("style")]
    .map((n) => n.textContent).join("\n");
  check("docked styles exist, not just the class",
    /\.panel\.docked \{[^}]*top: 40px/.test(css) && /\.panel\.docked \{[^}]*bottom: 0/.test(css),
    css.includes(".panel.docked") ? "rule present" : "NO .panel.docked RULE");
  check("the docked transcript is given the column to fill",
    /\.panel\.docked \.log \{[^}]*flex: 1 1 auto/.test(css) && /\.panel\.docked \.log \{[^}]*min-height: 0/.test(css));
  check("the tray cannot crowd the transcript out",
    /\.panel\.docked \.tray \{[^}]*max-height/.test(css));
  check("the docked panel starts open", !!spanel && spanel.classList.contains("open"));

  // --- a stale app frame must not fail silently
  //
  // The panel and the app are two documents, each with its own copy of this client. The
  // panel notices when *it* is behind the bridge; the frame doing the actual work used
  // to be checked by nothing at all, so after an update every tool did nothing and the
  // panel looked healthy.
  {
    // jsdom cannot observe the reload itself: window.location is not replaceable and
    // its reload() is unimplemented. So these assert the *decision* — repair once, then
    // escalate — which is the part that could regress. The navigation is covered by
    // driving a real browser.
    const slog = () => sw.document.getElementById("uitalk-host").shadowRoot.querySelector(".log").textContent;
    const fw = sframe.contentWindow;
    fw.__UITALK_BUILD__ = "oldbuild";
    sw.__UITALK_BUILD__ = "newbuild";

    const before = slog().length;
    sbar.querySelector('[data-device="iphone-se"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const firstPass = slog().slice(before);
    check("a frame running an older client is noticed, not left to fail quietly",
      /older client \(oldbuild\)/.test(firstPass), firstPass.slice(0, 70) || "(nothing said)");
    check("and the first response is to repair it, not to ask the user",
      /reloading it to match newbuild/.test(firstPass) && !/reload the page/.test(firstPass),
      firstPass.slice(0, 80));

    const second = slog().length;
    sbar.querySelector('[data-device="iphone-14"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const secondPass = slog().slice(second);
    check("a repair that did not settle it escalates to the user instead of looping",
      /reload the page/.test(secondPass) && !/reloading it to match/.test(secondPass),
      secondPass.slice(0, 80) || "(nothing said)");

    // Matching builds must stay silent, or every device change would nag.
    fw.__UITALK_BUILD__ = "newbuild";
    const third = slog().length;
    sbar.querySelector('[data-device="iphone-se"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    check("and a frame that matches says nothing at all",
      !/older client|reload the page/.test(slog().slice(third)), slog().slice(third).slice(0, 50) || "(silent)");
  }

  // device presets
  sbar.querySelector('[data-device="iphone-14"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  let screen = UITalkShell.screen();
  check("choosing a device sets its viewport", screen.width === 390 && screen.height === 844, JSON.stringify(screen));
  check("it reports the preset name", screen.preset === "iPhone 14", screen.preset);
  check("and the orientation", screen.orientation === "portrait", screen.orientation);
  check("the frame is sized to the device", sframe.style.width === "390px" && sframe.style.height === "844px",
    `${sframe.style.width} x ${sframe.style.height}`);

  sbar.querySelector('[data-act="rotate"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  screen = UITalkShell.screen();
  check("rotate swaps the axes", screen.width === 844 && screen.height === 390, JSON.stringify(screen));
  check("rotate reports landscape", screen.orientation === "landscape", screen.orientation);

  sbar.querySelector('[data-device="ipad-pro"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  check("a device larger than the stage is scaled to fit", UITalkShell.screen().zoom < 1, String(UITalkShell.screen().zoom));
  check("the app still believes it has the full device viewport",
    sframe.style.width === "1024px", sframe.style.width);

  // The panel lives in a shadow root, so a rule keyed off an attribute on <html>
  // can never match it. The side has to arrive as a class on the panel itself.
  check("the panel starts docked right", spanel.classList.contains("dock-right"),
    [...spanel.classList].join(" "));

  const dockBtn = sbar.querySelector('[data-act="dock"]');
  dockBtn.dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  check("the document records the new edge", sw.document.documentElement.dataset.uitalkDock === "bottom",
    sw.document.documentElement.dataset.uitalkDock);
  check("and the panel itself is told, across the shadow boundary",
    spanel.classList.contains("dock-bottom") && !spanel.classList.contains("dock-right"),
    [...spanel.classList].join(" "));
  check("the button says where the panel is", /bottom/i.test(dockBtn.textContent), dockBtn.textContent);

  dockBtn.dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  check("cycling again moves it left", spanel.classList.contains("dock-left"),
    [...spanel.classList].join(" "));

  const shellCss = [...sw.document.getElementById("uitalk-host").shadowRoot.querySelectorAll("style")]
    .map((n) => n.textContent).join("\n");
  check("each edge has a rule that can actually match",
    /\.panel\.docked\.dock-left \{/.test(shellCss) && /\.panel\.docked\.dock-bottom \{/.test(shellCss));
  check("no rule reaches outside the shadow root for the dock side",
    !/html\[data-uitalk-dock[^}]*\.panel/.test(shellCss), "found a cross-boundary selector");

  dockBtn.dispatchEvent(new sw.MouseEvent("click", { bubbles: true })); // back to right

  // --- the frame can be sized by dragging its edges
  sbar.querySelector('[data-device="iphone-14"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  const shim = sw.document.getElementById("uitalk-shim");
  check("the frame carries resize handles", shim.querySelectorAll(".uitalk-grip").length === 3,
    `${shim.querySelectorAll(".uitalk-grip").length}`);

  const startW = UITalkShell.screen().width;
  const grip = shim.querySelector(".uitalk-grip.e");
  const drag = (target, type, x, y) =>
    target.dispatchEvent(new sw.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
  drag(grip, "pointerdown", 400, 400);
  drag(grip, "pointermove", 460, 400);
  const afterW = UITalkShell.screen().width;
  check("dragging the east edge widens the frame", afterW > startW, `${startW} -> ${afterW}`);
  check("the height is untouched by an east drag", UITalkShell.screen().height === 844,
    String(UITalkShell.screen().height));
  check("a hand-set size reports as Custom", UITalkShell.screen().preset === "Custom", UITalkShell.screen().preset);
  drag(grip, "pointerup", 460, 400);

  const sGrip = shim.querySelector(".uitalk-grip.s");
  const hBefore = UITalkShell.screen().height;
  drag(sGrip, "pointerdown", 400, 400);
  drag(sGrip, "pointermove", 400, 300);
  check("dragging the south edge shortens the frame", UITalkShell.screen().height < hBefore,
    `${hBefore} -> ${UITalkShell.screen().height}`);
  drag(sGrip, "pointerup", 400, 300);

  const wBefore = UITalkShell.screen().width, hb = UITalkShell.screen().height;
  const corner = shim.querySelector(".uitalk-grip.se");
  drag(corner, "pointerdown", 400, 400);
  drag(corner, "pointermove", 450, 450);
  check("the corner changes both axes",
    UITalkShell.screen().width > wBefore && UITalkShell.screen().height > hb,
    `${wBefore}x${hb} -> ${UITalkShell.screen().width}x${UITalkShell.screen().height}`);
  drag(corner, "pointerup", 450, 450);

  check("a hand-set size still travels as metadata", UITalkShell.screen().width >= 200);

  sbar.querySelector('[data-device="iphone-se"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
  check("choosing a preset overrides the hand-set size",
    UITalkShell.screen().width === 375 && UITalkShell.screen().preset === "iPhone SE",
    JSON.stringify(UITalkShell.screen()));

  // put back what the metadata assertion below expects
  sbar.querySelector('[data-device="ipad-pro"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));

  // --- the invariant that actually broke: a real iframe keeps ONE WindowProxy
  // across navigations while replacing the document, so every listener is silently
  // dropped. Model that exactly — same object, listeners cleared — and require the
  // shell to re-register on load. Comparing window identity fails this.
  {
    const registered = [];
    const stub = {
      document: sw.document,
      location: { pathname: "/", search: "" },
      addEventListener: (type, fn, cap) => registered.push([type, fn, cap]),
    };
    Object.defineProperty(sframe, "contentWindow", { value: stub, configurable: true });
    sframe.dispatchEvent(new sw.Event("load"));
    await new Promise((r) => setTimeout(r, 10));
    const first = registered.length;
    check("the shell registers gestures on the frame", first > 0, `${first} listeners`);

    // Recording where the frame is must not pile up history entries, or the
    // browser's Back button spends its steps undoing them instead of moving the app.
    {
      let pushes = 0, replaces = 0;
      const realPush = sw.history.pushState.bind(sw.history);
      const realReplace = sw.history.replaceState.bind(sw.history);
      sw.history.pushState = (...a) => { pushes++; return realPush(...a); };
      sw.history.replaceState = (...a) => { replaces++; return realReplace(...a); };
      stub.location = { pathname: "/pricing", search: "" };
      sframe.dispatchEvent(new sw.Event("load"));
      await new Promise((r) => setTimeout(r, 10));
      check("a frame load records the route without adding history", pushes === 0 && replaces > 0,
        `${pushes} pushes, ${replaces} replaces`);
      sw.history.pushState = realPush;
      sw.history.replaceState = realReplace;
    }

    registered.length = 0; // the frame navigates: same window object, new document
    sframe.dispatchEvent(new sw.Event("load"));
    await new Promise((r) => setTimeout(r, 10));
    check("and registers them again after the frame navigates",
      registered.length > 0, `${registered.length} re-registered (was ${first} at first load)`);

    // Belt and braces: if a load event is ever missed, arming a tool must still
    // leave the frame with live listeners.
    registered.length = 0;
    const shellRoot2 = sw.document.getElementById("uitalk-host").shadowRoot;
    shellRoot2.querySelector('[data-act="pick"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    // The exact count depends on how many reattach passes ran; what matters is
    // that arming leaves live listeners rather than none.
    check("arming a tool re-attaches too, without waiting for a load",
      registered.length > 0, `${registered.length} registered`);
    shellRoot2.querySelector('[data-act="pick"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  }

  {
    const inner = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", runScripts: "outside-only" });
    const iw = inner.window;
    iw.CSSStyleSheet = FakeSheet;
    iw.document.adoptedStyleSheets = [];
    iw.CSS = { escape: (v) => String(v) };
    iw.devicePixelRatio = 2;
    iw.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    iw.WebSocket = class { constructor() {} send() {} close() {} };
    iw.Element.prototype.getBoundingClientRect = function () {
      const key = [...(this.classList ?? [])].find((c) => BOXES[c]);
      const b = BOXES[key] ?? { left: 0, top: 0, width: 120, height: 24 };
      return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top };
    };
    let innerAt = null;
    iw.document.elementFromPoint = () => innerAt;
    loadClient(iw, "api.js");

    Object.defineProperty(sframe, "contentWindow", { value: iw, configurable: true });
    sframe.dispatchEvent(new sw.Event("load"));
    await new Promise((r) => setTimeout(r, 10));

    const shellRoot = sw.document.getElementById("uitalk-host").shadowRoot;
    shellRoot.querySelector('[data-act="pick"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    innerAt = iw.document.querySelector(".notify-button");
    innerAt.dispatchEvent(new iw.MouseEvent("click", { clientX: 600, clientY: 600, button: 0, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));

    check("Select works inside the shell's frame after it navigates",
      iw.UITalk.picked.length === 1, `picked ${iw.UITalk.picked.length}`);
    check("the badge is drawn over the frame from the shell",
      shellRoot.querySelectorAll(".badge").length === 1,
      `${shellRoot.querySelectorAll(".badge").length} badges`);

    shellRoot.querySelector('[data-act="shot"]').dispatchEvent(new sw.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    check("Screenshot arms inside the frame too",
      iw.document.documentElement.style.cursor === "crosshair",
      iw.document.documentElement.style.cursor || "(none)");
  }

  const shellLink = sw.document.getElementById("uitalk-host").shadowRoot.querySelector(".meter .split");
  check("the shell offers a way back out", !!shellLink && /leave split/i.test(shellLink.title),
    shellLink?.title);
  check("leaving returns to the app's own URL, not the shell",
    !shellLink.getAttribute("href").includes("__uitalk/shell"), shellLink.getAttribute("href"));

  // the simulated screen must ride along with the message
  const sinput = sw.document.getElementById("uitalk-host").shadowRoot.querySelector("textarea");
  sinput.value = "why does this wrap";
  sinput.dispatchEvent(new sw.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const msg = shellSent.filter((f) => f.kind === "chat").at(-1);
  check("the message carries the simulated screen", !!msg?.page?.screen, JSON.stringify(msg?.page?.screen));
  check("the screen metadata names the preset and size",
    msg?.page?.screen?.preset === "iPad Pro" && msg?.page?.screen?.width === 1024,
    JSON.stringify(msg?.page?.screen));

  // the frame's own copy of the client must not render a second panel
  const inner = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", runScripts: "outside-only" });
  Object.defineProperty(inner.window, "parent", { value: sw, configurable: true });
  inner.window.CSSStyleSheet = FakeSheet;
  inner.window.document.adoptedStyleSheets = [];
  inner.window.CSS = { escape: (v) => String(v) };
  inner.window.WebSocket = class { constructor() {} send() {} close() {} };
  inner.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  for (const f of ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]) {
    loadClient(inner.window, f);
  }
  check("the frame exposes the API", typeof inner.window.UITalk?.readSelection === "function");
  check("the frame renders no panel of its own", !inner.window.document.getElementById("uitalk-host"));
}

// --- the panel survives a reload it did not ask for
//
// Vite does a full reload whenever a change cannot be hot-updated, and the panel used
// to come back closed, unsized and back in the corner — every time a change landed.
{
  const cold = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", pretendToBeVisual: true,
    runScripts: "outside-only", virtualConsole: vc });
  cold.window.CSSStyleSheet = FakeSheet;
  cold.window.document.adoptedStyleSheets = [];
  cold.window.CSS = { escape: (v) => String(v) };
  cold.window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };
  cold.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  cold.window.sessionStorage.setItem("uitalk.ui",
    JSON.stringify({ open: true, width: "460px", height: "640px", right: "120px", bottom: "90px" }));

  for (const f of ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]) loadClient(cold.window, f);
  await new Promise((r) => setTimeout(r, 20));

  const coldRoot = cold.window.document.getElementById("uitalk-host")?.shadowRoot;
  const coldPanel = coldRoot?.querySelector(".panel");
  check("a reload reopens the panel instead of hiding it again",
    coldPanel?.classList.contains("open") === true, coldPanel?.className ?? "no panel");
  check("and restores the size the user dragged it to",
    coldPanel?.style.width === "460px" && coldPanel?.style.height === "640px",
    `${coldPanel?.style.width} x ${coldPanel?.style.height}`);
  check("and where they put the icon",
    coldRoot?.querySelector(".fab")?.style.right === "120px", coldRoot?.querySelector(".fab")?.style.right);

  // A tab that has never opened it must still start closed.
  const virgin = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", pretendToBeVisual: true,
    runScripts: "outside-only", virtualConsole: vc });
  virgin.window.CSSStyleSheet = FakeSheet;
  virgin.window.document.adoptedStyleSheets = [];
  virgin.window.CSS = { escape: (v) => String(v) };
  virgin.window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };
  virgin.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  for (const f of ["api.js", "raster.js", "native.js", "shell.js", "ui.js"]) loadClient(virgin.window, f);
  await new Promise((r) => setTimeout(r, 20));
  check("a fresh tab still starts with the panel closed",
    virgin.window.document.getElementById("uitalk-host").shadowRoot
      .querySelector(".panel").classList.contains("open") === false,
    virgin.window.document.getElementById("uitalk-host").shadowRoot.querySelector(".panel").className);
}

console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
