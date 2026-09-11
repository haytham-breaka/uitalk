// Native capture: real pixels from the browser's compositor, via the Screen
// Capture API, rather than a re-rendered clone of the DOM.
//
// The rasterizer re-draws the page from computed styles, so anything it cannot
// reconstruct — canvas, video, cross-origin images, backdrop filters — comes out
// blank, and the crop depends on the clone laying out exactly like the original.
// A display stream has none of those problems: what is on screen is what is
// captured. The costs are a one-time permission prompt, and that only what is
// visible can be photographed.

globalThis.UITalkNative = (() => {
  const supported = () =>
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof HTMLCanvasElement !== "undefined";

  let stream = null;
  let video = null;
  let declined = false;

  function teardown() {
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    stream = null;
    if (video) {
      video.srcObject = null;
      video.remove();
      video = null;
    }
  }

  /** True once a stream is live; asks for one the first time, then reuses it. */
  async function ready() {
    if (!supported() || declined) return false;
    if (stream?.active && video?.videoWidth) return true;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        // Ask for this tab specifically so the picker is a formality rather than a
        // hunt, and so the capture cannot accidentally include another window.
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        // 60 so a strip can sample every compositor frame; below that interval
        // there is nothing new to capture, whatever the caller asks for.
        video: { displaySurface: "browser", frameRate: { ideal: 60, max: 60 } },
      });
    } catch (err) {
      // A refusal is a decision, not an error to retry on every shot.
      declined = err?.name === "NotAllowedError";
      teardown();
      throw new Error(
        declined
          ? "screen capture was declined; using the DOM renderer instead"
          : `screen capture is unavailable: ${err.message}`,
      );
    }

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        teardown(); // the user pressed "stop sharing"
      });
    }

    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0";
    document.documentElement.appendChild(video);
    await video.play();

    // The first frame is not always there the instant play() resolves.
    for (let i = 0; i < 60 && !video.videoWidth; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return Boolean(video.videoWidth);
  }

  const nextFrame = (budget = 120) =>
    new Promise((resolve) => {
      if (video?.requestVideoFrameCallback) {
        let settled = false;
        video.requestVideoFrameCallback(() => { settled = true; resolve(); });
        // The wait for a fresh frame must not exceed the spacing the caller asked
        // for, or a tight strip degrades into evenly-late samples.
        setTimeout(() => { if (!settled) resolve(); }, Math.max(20, budget));
      } else {
        setTimeout(resolve, Math.min(60, budget));
      }
    });

  /**
   * Grab a rectangle of this tab, in CSS pixels of *this* window.
   * @returns {Promise<{png: string, width: number, height: number, scale: number}>}
   */
  async function grab({ left, top, right, bottom }, { frameBudget = 120 } = {}) {
    if (!video?.videoWidth) throw new Error("no display stream");
    await nextFrame(frameBudget);

    // The stream is the tab's viewport, so one CSS pixel is this many stream
    // pixels — which is not devicePixelRatio when the stream is downscaled.
    const scale = video.videoWidth / window.innerWidth;

    const sx = Math.max(0, Math.round(left * scale));
    const sy = Math.max(0, Math.round(top * scale));
    const sw = Math.max(1, Math.min(Math.round((right - left) * scale), video.videoWidth - sx));
    const sh = Math.max(1, Math.min(Math.round((bottom - top) * scale), video.videoHeight - sy));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    return {
      png: canvas.toDataURL("image/png").split(",")[1],
      width: Math.round(right - left),
      height: Math.round(bottom - top),
      scale: Math.round(scale * 100) / 100,
    };
  }

  return {
    supported,
    ready,
    grab,
    stop: teardown,
    get active() {
      return Boolean(stream?.active && video?.videoWidth);
    },
    get declined() {
      return declined;
    },
    /** Let the user opt back in after declining once. */
    reset() {
      declined = false;
      teardown();
    },
  };
})();
