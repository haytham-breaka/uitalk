// Runs the injected client against a synthetic DOM under jsdom, so the selection,
// identity, geometry and preview logic can be exercised without a browser.
// jsdom has no real layout engine, so boxes are stubbed; what is under test here
// is the logic that reads and assembles them.

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
  <main class="coming-soon-main" style="display:flex;flex-direction:column;align-items:center;gap:24px">
    <h1 class="coming-soon-title">Something lovely is coming</h1>
    <form class="notify-form" style="display:flex;flex-direction:column;align-items:center;gap:12px">
      <input class="notify-input" name="email" aria-label="Email address" />
      <button class="notify-button" data-testid="notify-submit" type="submit">Notify me</button>
    </form>
  </main>
</body></html>`;

const dom = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", pretendToBeVisual: true, runScripts: "outside-only" });
const { window } = dom;

// --- stubs for what jsdom lacks -------------------------------------------
class FakeSheet {
  constructor() { this.text = ""; }
  replaceSync(t) { this.text = t; }
}
window.CSSStyleSheet = FakeSheet;
window.document.adoptedStyleSheets = [];
window.CSS = { escape: (v) => String(v).replace(/([^\w-])/g, "\\$1") }; // jsdom has no CSS.escape
// jsdom has no matchMedia either. A tiny evaluator for the width queries the tests
// use, against jsdom's 1024px viewport, so an @media block can be inactive here;
// and a CSS.supports that rejects one deliberately-unsupported condition.
window.matchMedia = (q) => {
  const w = window.innerWidth;
  const max = q.match(/max-width:\s*(\d+)px/);
  const min = q.match(/min-width:\s*(\d+)px/);
  return { media: q, matches: (!max || w <= Number(max[1])) && (!min || w >= Number(min[1])) };
};
window.CSS.supports = (q) => !/nonsense-property/.test(q);
window.devicePixelRatio = 2;
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
window.elementFromPointStub = null;
window.document.elementFromPoint = () => window.elementFromPointStub;

// jsdom returns zeroed rects; give each element a plausible box so the geometry
// and delta logic has something real to compute over.
const BOXES = {
  "coming-soon-title": { left: 460, top: 400, width: 520, height: 60 },
  "notify-input":  { left: 510, top: 520, width: 420, height: 52 },
  "notify-button": { left: 510, top: 584, width: 420, height: 52 },
  "notify-form":   { left: 510, top: 520, width: 420, height: 116 },
};
window.Element.prototype.getBoundingClientRect = function () {
  const key = [...this.classList].find((c) => BOXES[c]);
  const b = BOXES[key] ?? { left: 0, top: 0, width: 200, height: 40 };
  return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top };
};

// --- load the client ------------------------------------------------------
for (const file of ["api.js", "raster.js"]) {
  loadClient(window, file);
}
const UITalk = window.UITalk;

// raster.js defines the real rasterizer; it cannot run here, because it waits on
// an <img> load that jsdom never completes for an SVG data URI. Swap in a stand-in
// that reports what it was asked to render, so container-finding and crop geometry
// are still testable. Order matters: this has to come after the client loads, or
// raster.js overwrites it and capture() hangs forever.
const realRaster = window.UITalkRaster;
window.lastRaster = null;
window.UITalkRaster = {
  rasterize: async (el, opts = {}) => {
    window.lastRaster = { el, opts };
    const r = el.getBoundingClientRect();
    const pad = opts.pad ?? 16;
    const w = Math.ceil(r.width) + pad * 2, h = Math.ceil(r.height) + pad * 2;
    const cut = opts.clip
      ? { sw: Math.min(opts.clip.right - opts.clip.left, w), sh: Math.min(opts.clip.bottom - opts.clip.top, h) }
      : null;
    return { png: "stub", width: cut ? cut.sw : w, height: cut ? cut.sh : h, warnings: [] };
  },
};

// --- exercise ------------------------------------------------------------
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

check("raster.js defines a rasterizer", typeof realRaster?.rasterize === "function");

const input = window.document.querySelector(".notify-input");
const button = window.document.querySelector(".notify-button");
const title = window.document.querySelector(".coming-soon-title");

check("pick returns ref 1 then 2",
  UITalk.pick(input)?.ref === 1 && UITalk.pick(button)?.ref === 2);
check("stamps data-uitalk-ref", button.getAttribute("data-uitalk-ref") === "2");

// --- deselection and renumbering
UITalk.pick(title); // 1 input, 2 button, 3 title
check("a third pick is ref 3", title.getAttribute("data-uitalk-ref") === "3");

const off = UITalk.pick(button); // re-clicking a selected element drops it
check("re-clicking deselects", off?.action === "deselected" && off.ref === 2, JSON.stringify(off));
check("handle removed on deselect", !button.hasAttribute("data-uitalk-ref"));
check("remaining refs renumber", title.getAttribute("data-uitalk-ref") === "2", title.getAttribute("data-uitalk-ref"));
check("selection shrinks", UITalk.picked.length === 2 && off.total === 2);

// deselecting drops a preview, because it was authored against the old numbering
UITalk.tryStyle({ ref: 2, declarations: "color: red" });
const off2 = UITalk.unpick(2);
check("unpick by ref works", off2?.action === "deselected" && off2.ref === 2);
check("deselect clears a stale preview", off2.previewCleared === true && window.document.adoptedStyleSheets.length === 0);
check("unpick on an empty ref is a no-op", UITalk.unpick(9) === null);

// back to the pair the rest of the checks expect
UITalk.clearSelection();
UITalk.pick(input);
UITalk.pick(button);
check("reselect restores 1 and 2",
  input.getAttribute("data-uitalk-ref") === "1" && button.getAttribute("data-uitalk-ref") === "2");

const sel = UITalk.readSelection();
check("two elements selected", sel.selected === 2);
check("page path present", sel.page.path === "/", sel.page.path);
check("viewport + dpr present", sel.page.viewport.dpr === 2 && sel.page.viewport.w > 0);

const b = sel.items[1];
check("greppable identifiers on ref 2", b.testId === "notify-submit" && b.text === "Notify me", JSON.stringify({ testId: b.testId, text: b.text }));
check("classes captured", b.classes.includes("notify-button"));
check("ref selector usable", b.selector === '[data-uitalk-ref="2"]', b.selector);
check("source selector built", /notify-button/.test(b.sourceSelector), b.sourceSelector);
check("geometry read", b.rect.w === 420 && b.rect.h === 52, JSON.stringify(b.rect));

check("ancestor is the form", sel.ancestor.classes.includes("notify-form"), sel.ancestor.selector);
check("ancestor layout captured", sel.ancestor.layout.display === "flex" && sel.ancestor.layout.flexDirection === "column",
  JSON.stringify(sel.ancestor.layout));
check("delta computed", sel.deltas[0].topOffset === 64, JSON.stringify(sel.deltas[0]));
check("ref 2 is a direct child", sel.items[1].directChildOfAncestor === true);

const applied = UITalk.tryStyle({ ref: 2, declarations: "align-self: flex-start; color: red !important" });
const sheetText = window.document.adoptedStyleSheets[0]?.text ?? "";
check("preview rule doubles the attribute selector", sheetText.includes('[data-uitalk-ref="2"][data-uitalk-ref="2"]'), sheetText.slice(0, 70));
check("!important is stripped", !/!important/i.test(sheetText), sheetText);
check("tryStyle reports what it matched and how",
  applied.applied === true && /data-uitalk-ref="2"/.test(applied.matchedBy) && applied.target?.tag === "button",
  JSON.stringify({ matchedBy: applied.matchedBy, tag: applied.target?.tag }));

const opts = UITalk.showOptions({ ref: 2, options: [
  { label: "Pill", declarations: "border-radius: 999px" },
  { label: "Bold", declarations: "font-weight: 800" },
]});
check("options mounted", opts.mounted === 2 && opts.labels[0] === "Pill");
check("exactly one option sheet adopted", window.document.adoptedStyleSheets.filter((s) => /border-radius|font-weight/.test(s.text)).length === 1);
UITalk.flip(1);
check("flip switches the active option", UITalk.optionState.active === 1);

// -1 is the page's own styling, in the same sequence as the variants
check("flipping to -1 shows the original", UITalk.flip(-1) === -1 && UITalk.optionState.active === -1);
check("showing the original adopts no variant sheet",
  window.document.adoptedStyleSheets.filter((x) => /border-radius|font-weight/.test(x.text)).length === 0);
check("the original is not approvable", UITalk.chosenOption() === null);
check("stepping back from the original wraps to the last variant", UITalk.flip(-2) === 1, String(UITalk.optionState.active));
check("stepping past the last wraps to the original", UITalk.flip(2) === -1, String(UITalk.optionState.active));
check("jumping straight to a variant works", UITalk.flip(0) === 0 && UITalk.optionState.active === 0);
check("and re-adopts exactly one sheet",
  window.document.adoptedStyleSheets.filter((x) => /border-radius|font-weight/.test(x.text)).length === 1);
UITalk.flip(1); // restore what the assertion below expects
const chosen = UITalk.chosenOption();
check("chosen option carries identity + page", chosen.label === "Bold" && chosen.element.testId === "notify-submit" && !!chosen.page.path);

UITalk.resetPreview();
check("reset drops every preview sheet", window.document.adoptedStyleSheets.length === 0, String(window.document.adoptedStyleSheets.length));

// --- show_options guards against a malformed request rather than adopt(undefined)
{
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  const sheetsBefore = window.document.adoptedStyleSheets.length;
  check("show_options with zero options throws instead of adopting an undefined sheet",
    threw(() => UITalk.showOptions({ ref: 2, options: [] })));
  check("show_options with one option throws",
    threw(() => UITalk.showOptions({ ref: 2, options: [{ label: "a", declarations: "color: red" }] })));
  check("a rejected show_options leaves no preview state mounted",
    UITalk.optionState == null && window.document.adoptedStyleSheets.length === sheetsBefore,
    `state=${UITalk.optionState} sheets=${window.document.adoptedStyleSheets.length}`);

  const two = UITalk.showOptions({ ref: 2, options: [
    { label: "A", declarations: "color: red" },
    { label: "B", declarations: "color: blue" },
  ]});
  check("show_options with 2 options mounts", two.mounted === 2);
  UITalk.resetPreview();

  const ten = UITalk.showOptions({ ref: 2, options: Array.from({ length: 10 }, (_, i) => ({ label: "o" + i, declarations: "color: red" })) });
  check("show_options with 10 options mounts", ten.mounted === 10);
  UITalk.resetPreview();

  check("show_options with 11 options throws",
    threw(() => UITalk.showOptions({ ref: 2, options: Array.from({ length: 11 }, (_, i) => ({ label: "o" + i, declarations: "color: red" })) })));
  check("and still leaves nothing mounted",
    UITalk.optionState == null && window.document.adoptedStyleSheets.length === 0);
}

// --- try_markup is a visual mockup, not a faithful preview, and must say so
{
  const card = window.document.createElement("div");
  card.className = "throwaway-card";
  window.document.body.appendChild(card);
  const picked = UITalk.pick(card);

  const result = UITalk.tryMarkup({ ref: picked.ref, html: "<div>replaced</div>" });
  const replacement = window.document.querySelector(`[data-uitalk-ref="${picked.ref}"]`);
  check("try_markup does replace the element", result.applied === true && card.parentElement === null);
  check("and is honest that this is a mockup, not a functional preview",
    /visual mockup/.test(result.note) && /event bindings/.test(result.note), result.note);

  // unpicking drops the still-active markup preview as a side effect, which
  // swaps the original element back in — so it is `card`, not `replacement`,
  // that ends up back in the document afterward.
  UITalk.unpick(picked.ref);
  check("unpicking restores the original element in place of the preview",
    card.isConnected && !replacement.isConnected, { card: card.isConnected, replacement: replacement.isConnected });
  check("and the restored original carries no leftover ref attribute",
    !card.hasAttribute("data-uitalk-ref"), card.outerHTML);
  card.remove();
}

// --- try_markup parses relative to the target's real position, not a
// detached <div>, since generic-element parsing silently strips content that
// is only valid in a specific context (a table row outside a table, ...)
{
  const table = window.document.createElement("table");
  table.innerHTML = "<tbody><tr><td>old</td></tr></tbody>";
  window.document.body.appendChild(table);
  const row = table.querySelector("tr");
  const rowPick = UITalk.pick(row);

  const rowResult = UITalk.tryMarkup({ ref: rowPick.ref, html: "<tr><td>new</td></tr>" });
  const newRow = window.document.querySelector(`[data-uitalk-ref="${rowPick.ref}"]`);
  check("a <tr> is not stripped down to a detached <div>'s liking", rowResult.applied === true);
  check("the replacement is a real <tr>, still inside the table",
    newRow?.tagName === "TR" && newRow.closest("table") === table,
    newRow ? `${newRow.tagName} in table? ${newRow.closest("table") === table}` : "no element");
  check("its own content survived the parse", newRow?.textContent === "new", newRow?.textContent);

  UITalk.unpick(rowPick.ref);
  table.remove();

  const select = window.document.createElement("select");
  select.innerHTML = "<option>old</option>";
  window.document.body.appendChild(select);
  const option = select.querySelector("option");
  const optionPick = UITalk.pick(option);

  const optionResult = UITalk.tryMarkup({ ref: optionPick.ref, html: "<option>new</option>" });
  const newOption = window.document.querySelector(`[data-uitalk-ref="${optionPick.ref}"]`);
  check("an <option> parses correctly too", optionResult.applied === true && newOption?.tagName === "OPTION");

  UITalk.unpick(optionPick.ref);
  select.remove();

  // more than one top-level element is refused outright, not silently truncated
  const solo = window.document.createElement("div");
  solo.className = "solo";
  window.document.body.appendChild(solo);
  const soloPick = UITalk.pick(solo);
  let multiError = null;
  try {
    UITalk.tryMarkup({ ref: soloPick.ref, html: "<div>A</div><div>B</div>" });
  } catch (e) {
    multiError = e.message;
  }
  check("more than one top-level element is refused, not silently truncated to the first",
    /2 top-level elements/.test(multiError ?? ""), multiError);
  check("the original element is untouched after the refusal", solo.isConnected && solo.parentElement === window.document.body);

  // try_markup needs a ref; a call without one must be refused BEFORE resolving a
  // target, or resolving a selector would stamp a data-uitalk-target attribute on
  // the page and leave it there on a rejected call.
  let refError = null;
  try {
    UITalk.tryMarkup({ selector: ".solo", html: "<div>x</div>" });
  } catch (e) {
    refError = e.message;
  }
  check("try_markup without a ref is refused", /needs a selection ref/.test(refError ?? ""), refError);
  check("and a refused try_markup leaves no stray target attribute on the page",
    !solo.hasAttribute("data-uitalk-target") && !window.document.querySelector("[data-uitalk-target]"),
    solo.getAttribute("data-uitalk-target") ?? "none");

  UITalk.unpick(soloPick.ref);
  solo.remove();
}

// --- a re-render can replace the DOM node a ref points at without telling
// this side at all — React frequently preserves a node across a rerender, but
// a conditional branch or a keyed list change can swap it out entirely.
{
  const root = window.document.createElement("div");
  const oldBtn = window.document.createElement("button");
  oldBtn.textContent = "Buy";
  root.appendChild(oldBtn);
  window.document.body.appendChild(root);

  const stalePick = UITalk.pick(oldBtn);

  // the framework replaces the node in place; nothing here is told
  const newBtn = window.document.createElement("button");
  newBtn.textContent = "Buy";
  root.replaceChild(newBtn, oldBtn);
  check("the old node is genuinely disconnected after the swap", !oldBtn.isConnected);

  const sel = UITalk.readSelection();
  const staleItem = sel.items.find((it) => it.ref === stalePick.ref);
  check("read_selection flags the stale ref instead of silently reporting zeroed geometry",
    staleItem?.stale === true && /no longer exist/.test(sel.note ?? ""), JSON.stringify(staleItem));
  check("and gives no fabricated rect for it", staleItem?.rect === undefined, JSON.stringify(staleItem));

  let styleError = null;
  try {
    UITalk.tryStyle({ ref: stalePick.ref, declarations: "color: red" });
  } catch (e) {
    styleError = e.message;
  }
  check("try_style refuses a stale ref rather than previewing against a dead node",
    /no longer exists/.test(styleError ?? ""), styleError);
  check("and never adopts a preview sheet that could never match anything",
    window.document.adoptedStyleSheets.length === 0, window.document.adoptedStyleSheets.length);

  let describeError = null;
  try {
    UITalk.describeStyles({ ref: stalePick.ref });
  } catch (e) {
    describeError = e.message;
  }
  check("describe_styles refuses a stale ref the same way", /no longer exists/.test(describeError ?? ""), describeError);

  // a ref that was never picked at all is a different situation, and should
  // still say so distinctly from "it existed and then vanished"
  let neverError = null;
  try {
    UITalk.tryStyle({ ref: 999, declarations: "color: red" });
  } catch (e) {
    neverError = e.message;
  }
  check("a ref that was never selected gets a different message than a stale one",
    /no element is selected/.test(neverError ?? "") && !/no longer exists/.test(neverError ?? ""), neverError);

  UITalk.unpick(stalePick.ref);
  root.remove();
}

// --- a selector-targeted preview is attached by a stamped attribute, not the
// selector itself — a re-render that replaces the element leaves an already-
// adopted preview rule matching nothing, unless the target is reconciled
{
  const root = window.document.createElement("div");
  const oldBtn = window.document.createElement("button");
  oldBtn.className = "checkout-target";
  root.appendChild(oldBtn);
  window.document.body.appendChild(root);

  UITalk.tryStyle({ selector: ".checkout-target", declarations: "color: red" });
  const token = oldBtn.getAttribute("data-uitalk-target");
  check("the selector target is stamped with a handle", typeof token === "string" && token.length > 0, token);

  const newBtn = window.document.createElement("button");
  newBtn.className = "checkout-target";
  root.replaceChild(newBtn, oldBtn);
  check("the fresh node carries no handle before reconciliation", !newBtn.hasAttribute("data-uitalk-target"));

  UITalk.reconcileTargets(); // what ui.js's serve() calls before every RPC
  check("reconciliation re-stamps the same token onto the node the selector now matches",
    newBtn.getAttribute("data-uitalk-target") === token, newBtn.getAttribute("data-uitalk-target"));
  check("the already-adopted preview rule matches the new node again, without touching its CSS text",
    newBtn.matches(window.document.adoptedStyleSheets[0].text.match(/^([^{]+)\{/)[1].trim()));

  UITalk.resetPreview();
  root.remove();

  // a selector that stops matching anything at all must not throw
  const gone = window.document.createElement("div");
  window.document.body.appendChild(gone);
  const target = window.document.createElement("button");
  target.className = "vanishing-target";
  gone.appendChild(target);
  UITalk.tryStyle({ selector: ".vanishing-target", declarations: "color: blue" });
  gone.remove(); // the whole subtree, selector included, is gone now
  let reconcileError = null;
  try {
    UITalk.reconcileTargets();
  } catch (e) {
    reconcileError = e.message;
  }
  check("reconciling a selector that now matches nothing does not throw", reconcileError === null, reconcileError);
  UITalk.resetPreview();
}

// --- try_style shows one preview at a time, so a new one must not leave the
// previous selector target's handle stranded on the live DOM
{
  const wrap = window.document.createElement("div");
  const first = window.document.createElement("button");
  first.className = "preview-a";
  const second = window.document.createElement("button");
  second.className = "preview-b";
  wrap.append(first, second);
  window.document.body.appendChild(wrap);

  UITalk.tryStyle({ selector: ".preview-a", declarations: "color: red" });
  check("the first selector preview stamps its target", first.hasAttribute("data-uitalk-target"));
  UITalk.tryStyle({ selector: ".preview-b", declarations: "color: blue" });
  check("a second preview stamps its own target", second.hasAttribute("data-uitalk-target"));
  check("and clears the superseded first target's handle, leaving no stray attribute",
    !first.hasAttribute("data-uitalk-target") &&
      window.document.querySelectorAll("[data-uitalk-target]").length === 1,
    `${window.document.querySelectorAll("[data-uitalk-target]").length} stamped`);

  UITalk.resetPreview();
  wrap.remove();
}

// --- which rules actually style an element
{
  // a stylesheet with two competing rules and a media block
  const style = window.document.createElement("style");
  style.textContent = `
    .notify-button { padding: 10px; border-radius: 4px; }
    form.notify-form button.notify-button { padding: 14px 18px; }
    .notify-button:hover { padding: 20px; }
    @media (max-width: 600px) { .notify-button { border-radius: 0; } }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".notify-button" });
  check("it reports the rules that match", out.rules.length >= 3, `${out.rules.length} rules`);
  check("it names the stylesheet each came from",
    out.rules.every((r) => typeof r.source === "string" && r.source.length), JSON.stringify(out.rules[0]?.source));
  check("a more specific selector wins the property",
    /notify-form/.test(out.winners?.padding?.from ?? ""), out.winners?.padding?.from);
  check("and reports the winning value", out.winners?.padding?.value === "14px 18px",
    out.winners?.padding?.value);
  check("state rules are reported but do not win",
    out.rules.some((r) => r.state === ":hover") && !/hover/.test(out.winners?.padding?.from ?? ""),
    out.winners?.padding?.from);
  check("rules inside a media block carry the condition",
    out.rules.some((r) => (r.context ?? []).some((c) => /max-width/.test(c))),
    JSON.stringify(out.rules.find((r) => r.context)?.context));

  const narrowed = UITalk.describeStyles({ selector: ".notify-button", properties: ["border-radius"] });
  check("it can be narrowed to properties of interest",
    narrowed.rules.every((r) => Object.keys(r.declarations).every((k) => k === "border-radius")),
    JSON.stringify(narrowed.rules.map((r) => Object.keys(r.declarations))));

  button.setAttribute("style", "padding: 2px");
  const withInline = UITalk.describeStyles({ selector: ".notify-button" });
  check("an inline style is called out as beating everything",
    withInline.inline === "padding: 2px" && /inline/.test(withInline.note ?? ""), withInline.note);
  button.removeAttribute("style");
  style.remove();
}

// --- cascade correctness: the type/tag component of specificity must count too
{
  const wrap = window.document.createElement("div");
  wrap.className = "foo";
  wrap.innerHTML = `<div class="bar">text</div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // ".foo div" (0 ids, 1 class, 1 type) is more specific than ".foo *" (0 ids, 1
  // class, 0 types), even though ".foo *" comes later in source order.
  style.textContent = `
    .foo div { color: red; }
    .foo * { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".bar" });
  check("the type component of specificity decides the winner, not just source order",
    /\.foo div/.test(out.winners?.color?.from ?? ""), out.winners?.color?.from);
  check("and reports its value", out.winners?.color?.value === "red", out.winners?.color?.value);

  style.remove();
  wrap.remove();
}

// --- cascade correctness: !important beats specificity and source order
{
  const wrap = window.document.createElement("div");
  wrap.className = "foo";
  wrap.innerHTML = `<div class="bar baz">text</div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  style.textContent = `
    .bar { color: red !important; }
    .foo .bar.baz { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".bar" });
  check("!important wins even against a more specific later rule",
    out.winners?.color?.value === "red" && out.winners?.color?.from?.startsWith(".bar in"),
    JSON.stringify(out.winners?.color));
  check("the winner is flagged as important", out.winners?.color?.important === true);
  check("the important rule itself is flagged too",
    out.rules.find((r) => r.selector === ".bar")?.important?.includes("color"),
    JSON.stringify(out.rules.find((r) => r.selector === ".bar")));

  style.remove();
  wrap.remove();
}

// --- cascade correctness: :where() always contributes zero specificity
{
  const wrap = window.document.createElement("div");
  wrap.className = "foo";
  wrap.innerHTML = `<div class="bar">text</div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // :where(.foo) .bar has the specificity of ".bar" alone (0,1,0); plain "div.bar"
  // (0,1,1) is more specific and should win even though it comes first.
  style.textContent = `
    div.bar { color: red; }
    :where(.foo) .bar { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".bar" });
  check(":where() does not inflate specificity",
    /div\.bar/.test(out.winners?.color?.from ?? ""), out.winners?.color?.from);

  style.remove();
  wrap.remove();
}

// --- cascade correctness: :is()/:not() take their most specific argument's
// specificity, not a flat pseudo-class count plus everything inside
{
  const wrap = window.document.createElement("div");
  wrap.innerHTML = `<div class="app"><div class="page"><button class="bar special" id="special">x</button></div></div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // :is(#app, .page) button -> id:1 (from #app) + type:1 (button) = (1,0,1),
  // which beats .bar.special's two classes (0,2,0) on the id alone.
  style.textContent = `
    :is(#app, .page) button { color: red; }
    .bar.special { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: "#special" });
  check("a single :is(...) selector is matched at all, not shredded by a naive comma split",
    out.rules.some((r) => r.selector === ":is(#app, .page) button"),
    JSON.stringify(out.rules.map((r) => r.selector)));
  check(":is() takes its most specific argument's specificity, beating two classes with one id",
    out.winners?.color?.from?.startsWith(":is(#app, .page) button"), out.winners?.color?.from);

  style.remove();
  wrap.remove();
}

{
  const wrap = window.document.createElement("div");
  wrap.innerHTML = `<div class="page"><button class="bar" id="special">x</button></div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // :not(#special) .bar -> id:1 (from :not's argument) + class:1 (.bar) = (1,1,0),
  // which beats a lone .bar.other with two classes (0,2,0) on the id alone.
  style.textContent = `
    .bar.other { color: red; }
    :not(#nope) .bar { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".bar" });
  check(":not() contributes its argument's specificity on top of what's outside it",
    out.winners?.color?.from?.startsWith(":not(#nope) .bar"), out.winners?.color?.from);
  check("as exactly (1,1,0), not the old class-per-token approximation",
    JSON.stringify(out.rules.find((r) => r.selector === ":not(#nope) .bar")?.specificity) === "[1,1,0]",
    JSON.stringify(out.rules.find((r) => r.selector === ":not(#nope) .bar")?.specificity));

  style.remove();
  wrap.remove();
}

{
  const wrap = window.document.createElement("div");
  wrap.innerHTML = `<div class="app"><div class="page"><button class="bar" id="special">x</button></div></div>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // A :where() nested inside :is() must still contribute zero: the effective
  // specificity of :is(:where(.app), .page) is .page's alone, (0,1,0), plus
  // "button" (0,0,1) = (0,1,1) — less specific than three plain classes.
  style.textContent = `
    :is(:where(.app), .page) button { color: red; }
    .app .page .bar { color: blue; }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".bar" });
  check(":where() nested inside :is() still contributes zero",
    out.winners?.color?.from?.startsWith(".app .page .bar"), out.winners?.color?.from);
  check("as exactly (0,1,1), not the old approximation that also counts :is() and :where()'s own tokens",
    JSON.stringify(out.rules.find((r) => r.selector === ":is(:where(.app), .page) button")?.specificity) === "[0,1,1]",
    JSON.stringify(out.rules.find((r) => r.selector === ":is(:where(.app), .page) button")?.specificity));

  style.remove();
  wrap.remove();
}

// --- source location: confidence tiers, not a flat "found it or didn't"
{
  const none = UITalk.locateSource({ selector: ".notify-button" });
  check("no framework metadata is reported as confidence none, not a guess",
    none.confidence === "none" && none.source === null && Array.isArray(none.evidence) && none.evidence.length === 0,
    JSON.stringify(none));

  // React: a fake fiber, structured the way the real reconciler shapes one.
  const reactEl = window.document.createElement("div");
  window.document.body.appendChild(reactEl);
  reactEl.__reactFiber$test = {
    _debugSource: { fileName: "/src/Button.jsx", lineNumber: 12, columnNumber: 3 },
    _debugOwner: null,
    type: { name: "Button" },
  };
  const react = UITalk.locateSource({ selector: "div:last-child" });
  check("react debug source on the element itself is exact",
    react.confidence === "exact" && react.source.file === "/src/Button.jsx" && react.source.line === 12,
    JSON.stringify(react));
  check("and names the evidence that produced it",
    react.evidence?.[0]?.kind === "react-debug-source" && react.evidence[0].exact === true,
    JSON.stringify(react.evidence));
  check("and the component name, read off the fiber's own type",
    react.component === "Button", react.component);
  reactEl.remove();

  // React: the fiber lives on an ancestor, not the clicked element — still useful,
  // but not the exact line, so it must not be reported as "exact".
  const reactParent = window.document.createElement("div");
  const reactChild = window.document.createElement("span");
  reactParent.appendChild(reactChild);
  window.document.body.appendChild(reactParent);
  reactParent.__reactFiber$test = {
    _debugSource: { fileName: "/src/Card.jsx", lineNumber: 30, columnNumber: 1 },
    _debugOwner: null,
    type: { name: "Card" },
  };
  const reactAncestor = UITalk.locateSource({ selector: "span" });
  check("a fiber found on an ancestor is 'component' confidence, not 'exact'",
    reactAncestor.confidence === "component" && reactAncestor.evidence?.[0]?.exact === false,
    JSON.stringify(reactAncestor));
  check("and says so, rather than implying the line is exact",
    /nearest ancestor/.test(reactAncestor.note ?? ""), reactAncestor.note);
  reactParent.remove();

  // Svelte stamps every element in dev.
  const svelteEl = window.document.createElement("div");
  window.document.body.appendChild(svelteEl);
  svelteEl.__svelte_meta = { loc: { file: "/src/Nav.svelte", line: 5, column: 2 } };
  const svelte = UITalk.locateSource({ selector: "div:last-child" });
  check("svelte metadata on the element itself is exact",
    svelte.confidence === "exact" && svelte.source.file === "/src/Nav.svelte" && svelte.evidence?.[0]?.kind === "svelte-meta",
    JSON.stringify(svelte));
  svelteEl.remove();

  // Vue names the component's file but never a line within it, so this can never be
  // "exact" even when the element itself carries the metadata.
  const vueEl = window.document.createElement("div");
  window.document.body.appendChild(vueEl);
  vueEl.__vueParentComponent = { type: { __file: "/src/Widget.vue", __name: "Widget" } };
  const vue = UITalk.locateSource({ selector: "div:last-child" });
  check("vue is capped at 'component' confidence even on the element itself",
    vue.confidence === "component" && vue.source.file === "/src/Widget.vue" && vue.source.line === null,
    JSON.stringify(vue));
  check("and explains why, rather than silently omitting the line",
    /not a line/.test(vue.note ?? ""), vue.note);
  check("and still names the component", vue.component === "Widget", vue.component);
  vueEl.remove();
}

// --- cascade correctness: a rule inside an @media/@supports block that does not
// currently apply is reported, but must never be the winner — it's the rule that
// would win at a phone width, not the one controlling what the user sees now
{
  const wrap = window.document.createElement("div");
  wrap.innerHTML = `<button class="cond-target">x</button>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  // jsdom's viewport is 1024px: (max-width: 600px) is inactive, (min-width: 600px) active.
  style.textContent = `
    .cond-target { border-radius: 4px; padding: 2px; }
    @media (max-width: 600px) { .cond-target { border-radius: 0; } }
    @media (min-width: 600px) { .cond-target { padding: 9px; } }
    @supports (nonsense-property: 1) { .cond-target { padding: 99px; } }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".cond-target" });
  check("an @media block that does not match the viewport cannot supply the winner",
    out.winners?.["border-radius"]?.value === "4px", JSON.stringify(out.winners?.["border-radius"]));
  const inactive = out.rules.find((r) => /max-width/.test(r.context?.[0] ?? ""));
  check("but the inactive rule is still reported, marked as such",
    inactive?.active === false, JSON.stringify(inactive));
  check("an @media block that does match competes normally",
    out.winners?.padding?.value === "9px", JSON.stringify(out.winners?.padding));
  check("the context label reads as a condition, not doubled parentheses",
    out.rules.some((r) => r.context?.[0] === "Media (min-width: 600px)"),
    JSON.stringify(out.rules.map((r) => r.context?.[0]).filter(Boolean)));
  const supports = out.rules.find((r) => /Supports/.test(r.context?.[0] ?? ""));
  check("an @supports block the browser rejects is inactive too",
    supports ? supports.active === false && out.winners?.padding?.value === "9px" : true,
    supports ? JSON.stringify(supports) : "jsdom did not parse @supports, nothing to assert");

  style.remove();
  wrap.remove();
}

// --- cascade layers (@layer): layer order overrides specificity and source order,
// so the winner the agent is sent to edit must respect it, not fall back to "last
// rule wins". Each case is built so layer order and source order disagree.
{
  const wrap = window.document.createElement("div");
  wrap.innerHTML = `<p class="lyr">x</p>`;
  window.document.body.appendChild(wrap);

  const style = window.document.createElement("style");
  style.textContent = `
    @layer base, theme;
    /* (a) an unlayered normal declaration beats a layered one, even though the
       layer rule appears later in source order. */
    .lyr { color: green; }
    @layer theme { .lyr { color: red; } }
    /* (b) among layers, the later-declared layer wins even when its block appears
       earlier in source order (theme block precedes base block here). */
    @layer theme { .lyr { background: teal; } }
    @layer base { .lyr { background: navy; } }
    /* (c) for !important the layer order reverses: the earlier-declared layer wins,
       even though its block appears first (so source order would pick the other). */
    @layer base { .lyr { border-color: navy !important; } }
    @layer theme { .lyr { border-color: teal !important; } }
  `;
  window.document.head.appendChild(style);

  const out = UITalk.describeStyles({ selector: ".lyr" });
  const layered = out.rules.some((r) => r.layer);
  if (!layered) {
    // A jsdom without @layer in its CSSOM cannot exercise this; skip rather than
    // assert a false pass. Current jsdom does parse it — see tools comment.
    check("jsdom exposes cascade layers for this suite", false,
      "no rule carried a layer; @layer support may have regressed");
  } else {
    check("an unlayered normal declaration beats a later layered one",
      out.winners?.color?.value === "green", JSON.stringify(out.winners?.color));
    check("among layers the later-declared layer wins regardless of source order",
      out.winners?.background?.value === "teal", JSON.stringify(out.winners?.background));
    check("the winning layer is named so the agent knows where to edit",
      /layer theme/.test(out.winners?.background?.from ?? ""), out.winners?.background?.from);
    check("for !important the earlier-declared layer wins (order reversed)",
      out.winners?.["border-color"]?.value === "navy" && out.winners?.["border-color"]?.important === true,
      JSON.stringify(out.winners?.["border-color"]));
    check("layered rules carry their layer path in the rules list",
      out.rules.some((r) => r.layer === "theme") && out.rules.some((r) => r.layer === "base"),
      JSON.stringify(out.rules.map((r) => r.layer).filter(Boolean)));
  }

  style.remove();
  wrap.remove();
}

// --- capture over time: a still frame cannot show motion
{
  const t0 = Date.now();
  const delayed = await UITalk.capture({ region: { left: 520, top: 530, right: 760, bottom: 600 }, inventory: false, delay: 120 });
  check("capture can wait before the shutter", Date.now() - t0 >= 110 && !!delayed.png, `${Date.now() - t0}ms`);

  const strip = await UITalk.capture({ region: { left: 520, top: 530, right: 760, bottom: 600 }, inventory: false, frames: 3, every: 60 });
  check("frames returns a strip", Array.isArray(strip.frames) && strip.frames.length === 3,
    `${strip.frames?.length} frames`);
  check("each frame is timestamped", strip.frames.every((f, i) => typeof f.at === "number" && (i === 0 || f.at > 0)),
    JSON.stringify(strip.frames.map((f) => f.at)));
  check("the frames are spaced out", strip.frames[2].at >= 100, `last at +${strip.frames[2].at}ms`);
  check("a strip still carries a single png for callers that want one", typeof strip.png === "string");
  check("the inventory is not repeated for every frame", strip.inventory === undefined);

  const capped = await UITalk.capture({ region: { left: 520, top: 530, right: 760, bottom: 600 }, inventory: false, frames: 99, every: 10 });
  check("the frame count is capped", capped.frames.length <= 16, `${capped.frames.length} frames`);
}

// --- waiting for the page rather than guessing with a delay
{
  const soon = await UITalk.waitFor({ selector: ".notify-button", timeout: 500 });
  check("wait_for returns at once when it is already there", soon.found === true && soon.waitedMs < 300,
    `${soon.waitedMs}ms`);
  check("it reports what it matched", soon.matched?.classes?.includes("notify-button"),
    JSON.stringify(soon.matched?.classes));

  const missing = await UITalk.waitFor({ selector: ".never-appears", timeout: 300 });
  check("it gives up rather than hanging", missing.found === false && missing.timedOut === true,
    JSON.stringify(missing));

  const appears = window.document.createElement("div");
  appears.className = "late";
  setTimeout(() => window.document.body.appendChild(appears), 120);
  const waited = await UITalk.waitFor({ selector: ".late", timeout: 3000 });
  check("it resolves as soon as an element arrives", waited.found === true && waited.waitedMs >= 100,
    `${waited.waitedMs}ms`);

  appears.remove();
  const wentAway = await UITalk.waitFor({ selector: ".late", gone: true, timeout: 500 });
  check("it can wait for something to disappear, which is how you wait out a spinner",
    wentAway.found === true, JSON.stringify(wentAway));

  let bad = null;
  try { await UITalk.waitFor({ timeout: 100 }); } catch (e) { bad = e.message; }
  check("waiting for nothing in particular is refused", /selector or some text/.test(bad ?? ""), bad);
}

// --- targeting by CSS selector, for requests that arrive with only a screenshot
UITalk.clearSelection();
const bySel = UITalk.tryStyle({ selector: ".notify-button", declarations: "border-radius: 999px" });
check("try_style accepts a CSS selector", bySel.applied === true, JSON.stringify(bySel.target?.classes));
const adopted = () => window.document.adoptedStyleSheets.map((x) => x.text).join("\n");
const targetToken = button.getAttribute("data-uitalk-target");
check("it stamps a preview handle and doubles it for specificity",
  Boolean(targetToken) && adopted().includes(`[data-uitalk-target="${targetToken}"][data-uitalk-target="${targetToken}"]`),
  adopted().slice(0, 60));
check("the element carries the handle", button.hasAttribute("data-uitalk-target"));
check("it reports which element it matched", bySel.target?.classes?.includes("notify-button"));

let bad = null;
try { UITalk.tryStyle({ selector: ".does-not-exist", declarations: "color: red" }); } catch (e) { bad = e.message; }
check("a selector matching nothing is refused", /matches \.does-not-exist/.test(bad ?? ""), bad);
try { UITalk.tryStyle({ declarations: "color: red" }); } catch (e) { bad = e.message; }
check("neither ref nor selector is refused", /either a selection ref or a CSS selector/.test(bad ?? ""), bad);
try { UITalk.tryStyle({ ref: 7, declarations: "color: red" }); } catch (e) { bad = e.message; }
check("a missing ref suggests the selector route", /CSS selector/.test(bad ?? ""), bad);

const optsBySel = UITalk.showOptions({ selector: ".notify-button", options: [
  { label: "Pill", declarations: "border-radius: 999px" },
  { label: "Square", declarations: "border-radius: 0" },
]});
check("show_options accepts a selector", optsBySel.mounted === 2);
const chosenBySel = UITalk.chosenOption();
check("the approval still reports the element", chosenBySel?.element?.classes?.includes("notify-button"),
  JSON.stringify(chosenBySel?.element?.classes));
check("and reports no ref, since none was used", chosenBySel?.ref === null, String(chosenBySel?.ref));

UITalk.resetPreview();
check("reset strips the preview handle too", !button.hasAttribute("data-uitalk-target"));

// --- preview of what a rectangle would take, without taking it
UITalk.clearSelection();
const preview = UITalk.previewArea({ left: 500, top: 500, right: 950, bottom: 660 });
check("previewArea reports candidates", preview.length > 0, `${preview.length}`);
check("previewArea selects nothing", UITalk.picked.length === 0);
check("previewArea returns drawable boxes", typeof preview[0].rect.width === "number");
check("previewArea marks what is already picked", preview.every((c) => c.already === false));

// --- undo. The stack spans the session, so these are relative rather than absolute.
UITalk.clearSelection();
UITalk.pick(input);
UITalk.pick(button);
check("undo steps back one pick", UITalk.undo()?.total === 1 && UITalk.picked.length === 1, `${UITalk.picked.length}`);
check("undo renumbers what is left", input.getAttribute("data-uitalk-ref") === "1" && !button.hasAttribute("data-uitalk-ref"));
check("a second undo empties the selection", UITalk.undo()?.total === 0 && UITalk.picked.length === 0);

UITalk.pick(input);
UITalk.pick(button);
UITalk.clearSelection();
check("clearing is undoable", UITalk.undo()?.total === 2 && UITalk.picked.length === 2, `${UITalk.picked.length}`);
UITalk.unpick(1);
check("deselecting is undoable", UITalk.undo()?.total === 2, `${UITalk.picked.length}`);

UITalk.clearSelection();
const areaResult = UITalk.pickArea({ left: 500, top: 500, right: 950, bottom: 660 });
check("an area pick is undoable",
  areaResult.added.length > 0 && UITalk.undo()?.total === 0, `added ${areaResult.added.length}`);

UITalk.clearSelection();
UITalk.pick(input);
UITalk.tryStyle({ ref: 1, declarations: "color: red" });
check("undo clears a preview built on the old refs", UITalk.undo()?.previewCleared === true);

// draining the stack is the only way to reach its floor, since it spans the session
let guard = 200;
while (UITalk.canUndo() && guard-- > 0) UITalk.undo();
check("canUndo goes false once drained", UITalk.canUndo() === false, `guard left ${guard}`);
check("undo past the floor is a no-op", UITalk.undo() === null);

UITalk.clearSelection();
UITalk.pick(input);
UITalk.pick(button);

// --- rubber-band selection
UITalk.clearSelection();
const area = UITalk.pickArea({ left: 500, top: 500, right: 950, bottom: 660 });
check("area select picks the boxes inside", area.added.length > 0, JSON.stringify(area));
// A rectangle is the gesture for picking several things, so resolving to a single
// container means the user drew around the container to get at what is inside it. The
// form is enclosed here, and its two fields are what the drag was for.
check("a rectangle that resolves to one container steps inside it",
  UITalk.picked.includes(input) && UITalk.picked.includes(button) &&
  !UITalk.picked.includes(window.document.querySelector(".notify-form")),
  UITalk.picked.map((e) => e.className).join(" | "));
check("area refs are stamped", input.getAttribute("data-uitalk-ref") === "1");
check("and it still never takes a descendant of something it took",
  !UITalk.picked.some((el) => UITalk.picked.some((other) => other !== el && other.contains(el))),
  `${UITalk.picked.length} selected, none nested`);

// The container is still reachable, for when the wrapper really is the target.
UITalk.clearSelection();
const asContainer = UITalk.pickArea({ left: 500, top: 500, right: 950, bottom: 660 }, { container: true });
check("holding Alt takes the container instead",
  UITalk.picked.length === 1 && UITalk.picked[0] === window.document.querySelector(".notify-form"),
  `${asContainer.added.length} added: ${UITalk.picked.map((e) => e.className).join(" | ")}`);

// And the live highlight has to agree with what the release will take, or the preview
// is telling the user something untrue.
UITalk.clearSelection();
const bandPreview = UITalk.previewArea({ left: 500, top: 500, right: 950, bottom: 660 });
const bandContainer = UITalk.previewArea({ left: 500, top: 500, right: 950, bottom: 660 }, { container: true });
check("the drag highlight shows the same elements the release will take",
  bandPreview.length === 2 && bandContainer.length === 1,
  `${bandPreview.length} highlighted, ${bandContainer.length} with Alt`);

UITalk.clearSelection();
UITalk.pickArea({ left: 500, top: 500, right: 950, bottom: 660 });

const again = UITalk.pickArea({ left: 500, top: 500, right: 950, bottom: 660 });
check("re-dragging the same area adds nothing", again.added.length === 0 && again.already > 0, JSON.stringify(again));

const tiny = UITalk.pickArea({ left: 500, top: 500, right: 503, bottom: 502 });
check("a tiny rectangle is rejected", tiny.added.length === 0 && !!tiny.note, tiny.note);

const outside = UITalk.pickArea({ left: 0, top: 0, right: 40, bottom: 40 });
check("an empty rectangle selects nothing", outside.added.length === 0);

UITalk.clearSelection();
UITalk.pick(input);
UITalk.pick(button);

// --- region capture
window.elementFromPointStub = window.document.querySelector(".notify-input");
const shot = await UITalk.capture({ region: { left: 520, top: 530, right: 760, bottom: 600 }, inventory: false });
check("region capture returns the region it was asked for",
  shot.region.x === 520 && shot.region.y === 530 && shot.region.w === 240 && shot.region.h === 70,
  JSON.stringify(shot.region));
check("it rasterizes a container that fully holds the region",
  window.lastRaster.el.classList.contains("notify-form") || window.lastRaster.el === window.document.body,
  window.lastRaster.el.className || window.lastRaster.el.tagName);
check("the clip is passed through to the rasterizer",
  window.lastRaster.opts.clip?.left === 520 && window.lastRaster.opts.clip?.bottom === 600,
  JSON.stringify(window.lastRaster.opts.clip));
check("output is cropped to the region, not the container",
  shot.width === 240 && shot.height === 70, `${shot.width}x${shot.height}`);

const clamped = await UITalk.capture({ region: { left: 700, top: 540, right: -50, bottom: 500 }, inventory: false });
check("a backwards/offscreen rectangle is normalised",
  clamped.region.x === 0 && clamped.region.w === 700, JSON.stringify(clamped.region));

let tooSmall = null;
try { await UITalk.capture({ region: { left: 10, top: 10, right: 13, bottom: 12 } }); }
catch (err) { tooSmall = err.message; }
check("a tiny region is refused", /too small/.test(tooSmall ?? ""), tooSmall);

const scan = UITalk.scanRegion({ x: 500, y: 500, w: 460, h: 160 });
check("scan_region returns elements", Array.isArray(scan.elements));

UITalk.clearSelection();
check("clear removes the handles", !button.hasAttribute("data-uitalk-ref") && UITalk.picked.length === 0);

console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
