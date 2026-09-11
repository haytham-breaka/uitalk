// The two capture paths, with the browser APIs they need stood up as fakes.
//
// jsdom has no Screen Capture API and cannot rasterize anything, which is why these
// files sat at 24% and 58%. But the parts that actually go wrong — the crop
// arithmetic, the permission and teardown states, the embedding deadline, the
// warnings — are ordinary logic, and that is what is exercised here. What is NOT
// faked is the rendering itself: a mock of that would only measure the mock.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
};

function makeWindow({ streamWidth = 2880, innerWidth = 1440 } = {}) {
  const dom = new JSDOM("<!doctype html><body><div class='box'>hi</div></body>", {
    url: "http://127.0.0.1:8400/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.devicePixelRatio = 2;
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });

  // A canvas that records what was drawn instead of drawing it.
  const drawn = [];
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      scale: () => {},
      drawImage: (...args) => drawn.push(args.slice(1)),
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return `data:image/png;base64,PIXELS-${this.width}x${this.height}`;
  };

  return { window, drawn };
}

// ------------------------------------------------------------------ native
{
  const { window, drawn } = makeWindow();

  const tracks = [];
  let prompts = 0;
  let deny = null;
  window.navigator.mediaDevices = {
    getDisplayMedia: async (constraints) => {
      prompts++;
      if (deny) throw Object.assign(new Error(deny.message), { name: deny.name });
      const track = {
        stop: () => (track.stopped = true),
        addEventListener: (t, fn) => (track["on" + t] = fn),
        stopped: false,
        constraints,
      };
      tracks.push(track);
      return { active: true, getTracks: () => [track] };
    },
  };

  // a <video> that reports a frame the moment it is played
  Object.defineProperty(window.HTMLVideoElement.prototype, "videoWidth",
    { get() { return this._w ?? 0; }, configurable: true });
  Object.defineProperty(window.HTMLVideoElement.prototype, "videoHeight",
    { get() { return this._h ?? 0; }, configurable: true });
  window.HTMLVideoElement.prototype.play = async function () { this._w = 2880; this._h = 1800; };
  window.HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) { setTimeout(fn, 1); };

  const url = new URL("../client/native.js", import.meta.url);
  window.eval(`${readFileSync(url, "utf8")}\n//# sourceURL=${fileURLToPath(url)}`);
  const N = window.UITalkNative;

  check("it reports itself supported when the API is there", N.supported() === true);
  check("nothing is active before a stream is asked for", N.active === false);

  check("the first capture asks for a stream", (await N.ready()) === true && prompts === 1, `${prompts} prompts`);
  check("it asks for this tab specifically, not a picker free-for-all",
    tracks[0].constraints.preferCurrentTab === true && tracks[0].constraints.video.displaySurface === "browser",
    JSON.stringify(tracks[0].constraints.video));
  check("a second capture reuses the stream rather than prompting again",
    (await N.ready()) === true && prompts === 1, `${prompts} prompts`);
  check("and reports itself active", N.active === true);

  // the crop arithmetic: stream pixels per CSS pixel is not devicePixelRatio
  drawn.length = 0;
  const shot = await N.grab({ left: 100, top: 50, right: 300, bottom: 150 });
  check("a grab reports the region in CSS pixels", shot.width === 200 && shot.height === 100,
    `${shot.width}x${shot.height}`);
  check("the scale is stream pixels per CSS pixel", shot.scale === 2, String(shot.scale));
  check("the source rectangle is scaled into stream space",
    JSON.stringify(drawn[0].slice(0, 4)) === JSON.stringify([200, 100, 400, 200]),
    JSON.stringify(drawn[0]?.slice(0, 4)));
  check("the canvas is sized in stream pixels", /PIXELS-400x200/.test(shot.png), shot.png);

  const clipped = await N.grab({ left: 1400, top: 880, right: 2000, bottom: 1200 });
  check("a region past the edge of the stream is clamped to what exists",
    drawn.at(-1)[0] + drawn.at(-1)[2] <= 2880 && drawn.at(-1)[1] + drawn.at(-1)[3] <= 1800,
    JSON.stringify(drawn.at(-1)));
  check("and still returns an image", typeof clipped.png === "string");

  // the user pressing "stop sharing"
  tracks[0].onended?.();
  check("ending the share tears the stream down", N.active === false);
  check("and the track is stopped", tracks[0].stopped === true);
  check("grabbing with no stream is refused, not a null dereference",
    await N.grab({ left: 0, top: 0, right: 10, bottom: 10 }).then(() => false, (e) => /no display stream/.test(e.message)));

  // a refusal is a decision, not something to re-ask on every shot
  deny = { name: "NotAllowedError", message: "denied" };
  let refusal = null;
  await N.ready().catch((e) => (refusal = e.message));
  check("a refusal explains the fallback", /declined/.test(refusal ?? ""), refusal);
  check("and is remembered", N.declined === true);
  const before = prompts;
  check("so it does not prompt again", (await N.ready()) === false && prompts === before, `${prompts} prompts`);
  N.reset();
  check("reset lets the user opt back in", N.declined === false);

  deny = { name: "NotFoundError", message: "no screen" };
  let other = null;
  await N.ready().catch((e) => (other = e.message));
  check("a failure that is not a refusal is reported as unavailable",
    /unavailable/.test(other ?? "") && N.declined === false, other);
}

// ------------------------------------------------------------------ raster
{
  const { window } = makeWindow();

  const requested = [];
  window.fetch = async (url, opts) => {
    requested.push(String(url));
    if (String(url).includes("slow")) {
      // never resolves on its own: the deadline has to be what ends it
      return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (String(url).includes("cross-origin")) throw new Error("blocked");
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };

  // an <img> that loads whatever it is given
  Object.defineProperty(window.HTMLImageElement.prototype, "src", {
    configurable: true,
    set(v) { this._src = v; setTimeout(() => this.onload?.(), 1); },
    get() { return this._src; },
  });

  window.getComputedStyle = () => ({
    getPropertyValue: (p) => ({ display: "block", margin: "12px", padding: "4px" })[p] ?? "",
    position: "static", display: "block", backgroundColor: "rgb(0, 0, 0)",
    visibility: "visible", opacity: "1",
  });
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 100, top: 200, width: 400, height: 300, right: 500, bottom: 500, x: 100, y: 200 };
  };

  const url = new URL("../client/raster.js", import.meta.url);
  window.eval(`${readFileSync(url, "utf8")}\n//# sourceURL=${fileURLToPath(url)}`);
  const R = window.UITalkRaster;
  const el = window.document.querySelector(".box");

  const whole = await R.rasterize(el);
  check("a full-element render comes back as base64", /^PIXELS/.test(whole.png) || whole.png.length > 0,
    whole.png.slice(0, 20));
  check("its canvas covers the element plus padding", whole.width === 432 && whole.height === 332,
    `${whole.width}x${whole.height}`);

  const cropped = await R.rasterize(el, { clip: { left: 150, top: 250, right: 350, bottom: 400 } });
  check("a clipped render returns the region asked for", cropped.width === 200 && cropped.height === 150,
    `${cropped.width}x${cropped.height}`);

  // images and fonts have to be embedded, because the SVG loads nothing
  window.document.body.insertAdjacentHTML("beforeend",
    '<img src="/local.png"><img src="http://other.example/cross-origin.png">');
  const withImages = await R.compose(window.document.body, {});
  check("a same-origin image is fetched for embedding", requested.some((u) => /local\.png/.test(u)),
    requested.join(", ").slice(0, 60));
  check("one that cannot be embedded is reported, not silently blank",
    withImages.warnings.some((w) => /cross-origin/.test(w)),
    withImages.warnings.join(" | ").slice(0, 80));

  window.document.body.insertAdjacentHTML("beforeend", '<img src="/slow.png">');
  const started = Date.now();
  const slow = await R.compose(window.document.body, {});
  check("a request still in flight does not hold the shutter open", Date.now() - started < 4000,
    `${Date.now() - started}ms`);
  check("and is reported as missing rather than pretended",
    slow.warnings.some((w) => /still loading/.test(w)), slow.warnings.join(" | ").slice(0, 80));

  window.document.body.insertAdjacentHTML("beforeend", "<canvas></canvas><video></video>");
  const unrenderable = await R.compose(window.document.body, {});
  check("content the renderer cannot reproduce is called out",
    unrenderable.warnings.some((w) => /canvas/.test(w)) && unrenderable.warnings.some((w) => /video/.test(w)),
    unrenderable.warnings.filter((w) => /canvas|video/.test(w)).join(" | "));

  let tooSmall = null;
  const hidden = window.document.createElement("span");
  hidden.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
  window.document.body.appendChild(hidden);
  await R.rasterize(hidden).catch((e) => (tooSmall = e.message));
  check("an element with no visible box is refused", /no visible box/.test(tooSmall ?? ""), tooSmall);
}

console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
