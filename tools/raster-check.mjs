// Geometry of the region crop. jsdom cannot rasterize, but it can run the whole
// compose step — which is where the coordinate mapping lives, and where a crop
// that misses the area the user dragged comes from.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = `<!doctype html><html><body>
  <main class="page">
    <section class="hero"><h1 class="title">Get early access</h1>
      <form class="signup"><input class="email"><button class="go">Join</button></form>
    </section>
  </main>
</body></html>`;

const dom = new JSDOM(HTML, { url: "http://127.0.0.1:8400/", pretendToBeVisual: true, runScripts: "outside-only" });
const { window } = dom;
window.devicePixelRatio = 2;
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.CSS = { escape: (v) => String(v) };
window.fetch = async () => { throw new Error("offline in this harness"); };

// A section that is NOT at the origin, with a margin — the case that shifted the crop.
const BOXES = {
  page:   { left: 0,   top: 0,   width: 1200, height: 900 },
  hero:   { left: 120, top: 260, width: 860,  height: 420 },
  title:  { left: 140, top: 280, width: 500,  height: 60 },
  signup: { left: 140, top: 380, width: 508,  height: 132 },
  email:  { left: 140, top: 380, width: 340,  height: 52 },
  go:     { left: 490, top: 380, width: 158,  height: 52 },
};
window.Element.prototype.getBoundingClientRect = function () {
  const key = [...(this.classList ?? [])].find((c) => BOXES[c]);
  const b = BOXES[key] ?? { left: 0, top: 0, width: 10, height: 10 };
  return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top };
};

const styles = { margin: "40px", padding: "24px", position: "static", display: "block" };
window.getComputedStyle = (el) => ({
  getPropertyValue: (p) => styles[p] ?? "",
  position: styles.position,
  display: styles.display,
  backgroundColor: "rgb(12, 14, 18)",
  visibility: "visible",
  opacity: "1",
});

for (const f of ["api.js", "raster.js"]) {
  const url = new URL(`../client/${f}`, import.meta.url);
  window.eval(`${readFileSync(url, "utf8")}\n//# sourceURL=${fileURLToPath(url)}`);
}

const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail.push(n); };

const hero = window.document.querySelector(".hero");
const PAD = 16;

// the user drags exactly over the signup row
const region = { left: 140, top: 380, right: 648, bottom: 512 };
const out = await window.UITalkRaster.compose(hero, { clip: region });

check("the canvas covers the container plus padding",
  out.width === 860 + PAD * 2 && out.height === 420 + PAD * 2, `${out.width}x${out.height}`);

// the container sits at (pad, pad), so the region maps to its offset within it
check("the crop starts at the region's offset inside the container",
  out.cut.sx === region.left - 120 + PAD && out.cut.sy === region.top - 260 + PAD,
  `sx=${out.cut.sx} sy=${out.cut.sy} (expected ${region.left - 120 + PAD}, ${region.top - 260 + PAD})`);

check("the crop is exactly the size dragged",
  out.cut.sw === 508 && out.cut.sh === 132, `${out.cut.sw}x${out.cut.sh}`);

// The wrapper also carries margin:0, so look at the cloned ROOT's own style.
const rootStyle = (out.svg.match(/<section[^>]*style="([^"]*)"/) ?? [])[1] ?? "";
check("the cloned root's margin is zeroed, or every mapped coordinate shifts by it",
  /(^|;)margin:0(;|$)/.test(rootStyle), rootStyle.slice(0, 80) || "no root style");
check("the cloned root is border-box",
  /box-sizing:border-box/.test(rootStyle), rootStyle.slice(0, 80));

check("the root's box is pinned to its measured size",
  /width:860px/.test(rootStyle) && /height:420px/.test(rootStyle), rootStyle.slice(0, 120));

check("the wrapper is border-box, so its padding does not widen the canvas",
  /box-sizing:border-box;width:892px/.test(out.svg));

// a region hanging off the container's right edge must not read past the source
const over = await window.UITalkRaster.compose(hero, { clip: { left: 900, top: 600, right: 1300, bottom: 700 } });
check("a region past the container's edge is clamped to what exists",
  over.cut.sx + over.cut.sw <= over.width && over.cut.sy + over.cut.sh <= over.height,
  `sx+sw=${over.cut.sx + over.cut.sw} of ${over.width}`);
check("and says so", over.warnings.some((w) => /cropped/.test(w)), over.warnings.join(" | ") || "no warning");

console.log(fail.length ? `\n${fail.length} failing` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
