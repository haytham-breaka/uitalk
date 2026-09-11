// Rasterize a live element to PNG inside the page.
//
// The element is cloned, its computed styles are flattened onto the clone, and
// the result is drawn through an <svg><foreignObject> into a canvas. An SVG
// rendered this way is an isolated document: it loads no external resource, so
// images and web fonts have to be embedded as data URIs first. Anything that
// could not be embedded is reported back in `warnings` rather than silently
// producing a misleading picture.

globalThis.UITalkRaster = (() => {
  // Flattening every computed property would multiply the payload for no gain.
  // These are the ones that change how a box looks.
  const PROPS = [
    "display", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin", "padding", "border", "border-radius", "outline", "box-shadow",
    "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-clip",
    "color", "opacity", "visibility", "overflow", "mix-blend-mode", "filter", "backdrop-filter",
    "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height",
    "letter-spacing", "word-spacing", "text-align", "text-decoration", "text-transform", "text-shadow",
    "text-overflow", "white-space", "word-break", "vertical-align", "list-style",
    "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "gap", "row-gap", "column-gap",
    "align-items", "align-self", "align-content", "justify-content", "justify-items", "justify-self", "order",
    "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "grid-auto-flow",
    "transform", "transform-origin", "object-fit", "object-position", "aspect-ratio",
    "border-collapse", "table-layout", "cursor",
  ];

  const dataUri = (mime, b64) => `data:${mime};base64,${b64}`;

  async function fetchAsDataUri(url, timeoutMs = 1500) {
    // A page mid-load has requests in flight. Waiting for them turns "show me what
    // is on screen now" into "show me whenever the backend finishes", so every
    // embed races a deadline and whatever missed it is reported instead.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    try {
      return await fetchInner(url, stop.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchInner(url, signal) {
    const res = await fetch(url, { credentials: "same-origin", signal });
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = await res.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return dataUri(res.headers.get("content-type") ?? "application/octet-stream", btoa(bin));
  }

  function flatten(source, clone, warnings, isRoot) {
    if (source.nodeType !== Node.ELEMENT_NODE) return;
    const cs = getComputedStyle(source);

    let css = "";
    for (const prop of PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && value !== "none" && value !== "auto" && value !== "normal") {
        css += `${prop}:${value};`;
      }
    }

    if (isRoot) {
      // The crop is measured from the root's border box sitting exactly at the
      // padding offset. A margin would push the clone away from there and shift
      // every mapped coordinate, so pin the root's box precisely.
      const r = source.getBoundingClientRect();
      css += `margin:0;box-sizing:border-box;width:${Math.ceil(r.width)}px;height:${Math.ceil(r.height)}px;`;

      // A positioned root would resolve against an ancestor the clone does not
      // have, so pin it back to static and say so.
      if (cs.position !== "static") {
        css += "position:static;";
        warnings.push(`root is position:${cs.position}; rendered as static, so its offset is not reflected`);
      }
    }

    clone.setAttribute("style", css);
    clone.removeAttribute("class"); // styles are flattened; class rules cannot apply inside the SVG

    const sourceKids = [...source.childNodes];
    const cloneKids = [...clone.childNodes];
    for (let i = 0; i < sourceKids.length; i++) {
      if (cloneKids[i]) flatten(sourceKids[i], cloneKids[i], warnings, false);
    }
  }

  async function embedImages(clone, warnings) {
    const jobs = [...clone.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        img.setAttribute("src", await fetchAsDataUri(new URL(src, location.href).href));
      } catch (err) {
        img.removeAttribute("src");
        warnings.push(
          err?.name === "AbortError"
            ? `image ${src.slice(0, 60)} was still loading; captured without it`
            : `could not embed image ${src.slice(0, 60)} (likely cross-origin); it renders blank`,
        );
      }
    });

    for (const el of clone.querySelectorAll("canvas, video, iframe")) {
      warnings.push(`<${el.tagName.toLowerCase()}> cannot be rasterized; it renders blank`);
    }
    await Promise.all(jobs);
  }

  // Web fonts must travel inside the SVG or the text falls back to a system
  // face, which would misrepresent the very thing being reviewed.
  async function embedFonts(warnings) {
    const faces = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        warnings.push(`stylesheet ${sheet.href?.slice(0, 60) ?? "(inline)"} is cross-origin; its @font-face rules were skipped`);
        continue;
      }
      for (const rule of rules ?? []) {
        if (rule.constructor.name !== "CSSFontFaceRule" && !/@font-face/.test(rule.cssText ?? "")) continue;
        faces.push(rule);
      }
    }

    const out = [];
    for (const rule of faces.slice(0, 12)) {
      const urls = [...(rule.cssText.match(/url\(["']?([^"')]+)["']?\)/g) ?? [])];
      let text = rule.cssText;
      for (const raw of urls) {
        const url = raw.replace(/^url\(["']?|["']?\)$/g, "");
        if (url.startsWith("data:")) continue;
        try {
          text = text.replace(raw, `url(${await fetchAsDataUri(new URL(url, location.href).href)})`);
        } catch {
          warnings.push(`could not embed font ${url.slice(0, 60)}; text may fall back`);
        }
      }
      out.push(text);
    }
    return out.join("\n");
  }

  function backdrop(el) {
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    }
    return getComputedStyle(document.body).backgroundColor || "#fff";
  }

  /**
   * `clip`, when given, is a viewport rectangle to crop the result to. The element
   * still has to be rasterized whole, because a rectangle is not a thing that can
   * be cloned — so we render its nearest container and cut the region out.
   * @returns {Promise<{png:string,width:number,height:number,warnings:string[]}>}
   */
  async function rasterize(el, opts = {}) {
    const { svg, cut, width, height, warnings } = await compose(el, opts);
    const png = await draw(svg, width, height, cut);
    return { png, width: cut ? cut.sw : width, height: cut ? cut.sh : height, warnings };
  }

  /** Everything up to the pixels: clone, flatten, embed, and work out the crop. */
  async function compose(el, { pad = 16, maxWidth = 1600, clip = null } = {}) {
    const warnings = [];
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) throw new Error("the element has no visible box to capture");

    const clone = el.cloneNode(true);
    flatten(el, clone, warnings, true);
    await embedImages(clone, warnings);
    const fontCss = await embedFonts(warnings);

    const w = Math.ceil(rect.width) + pad * 2;
    const h = Math.ceil(rect.height) + pad * 2;
    if (w * h > maxWidth * maxWidth) {
      warnings.push(`the containing element is ${w}x${h}px; the capture may be slow or truncated by the browser`);
    }
    const body = new XMLSerializer().serializeToString(clone);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${w}px;` +
      `padding:${pad}px;margin:0;background:${backdrop(el)}">` +
      (fontCss ? `<style>${fontCss.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</style>` : "") +
      body +
      `</div></foreignObject></svg>`;

    // The SVG places the element's top-left, minus the padding, at (0,0).
    let cut = null;
    if (clip) {
      const sx = Math.max(0, Math.min(clip.left - rect.left + pad, w - 1));
      const sy = Math.max(0, Math.min(clip.top - rect.top + pad, h - 1));
      cut = {
        sx,
        sy,
        // Bound by what is actually left of the source past sx/sy. Clamping to the
        // full canvas size instead asked drawImage for pixels beyond the image,
        // which it fills with nothing.
        sw: Math.max(1, Math.min(clip.right - clip.left, w - sx)),
        sh: Math.max(1, Math.min(clip.bottom - clip.top, h - sy)),
      };
      const wanted = { w: Math.round(clip.right - clip.left), h: Math.round(clip.bottom - clip.top) };
      if (cut.sw < wanted.w - 1 || cut.sh < wanted.h - 1) {
        warnings.push(
          `asked for ${wanted.w}x${wanted.h}px but only ${Math.round(cut.sw)}x${Math.round(cut.sh)}px ` +
            `was inside the containing element, so the capture is cropped`,
        );
      }
    }

    return { svg, cut, width: w, height: h, warnings };
  }

  function draw(svg, w, h, cut) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const out = cut ? { w: cut.sw, h: cut.sh } : { w, h };
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(out.w * dpr);
        canvas.height = Math.round(out.h * dpr);
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        if (cut) ctx.drawImage(img, cut.sx, cut.sy, cut.sw, cut.sh, 0, 0, cut.sw, cut.sh);
        else ctx.drawImage(img, 0, 0);
        try {
          resolve(canvas.toDataURL("image/png").split(",")[1]);
        } catch (err) {
          reject(new Error(`canvas was tainted: ${err.message}`));
        }
      };
      img.onerror = () =>
        reject(new Error("the browser refused to render the cloned markup as an image"));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  return { rasterize, compose };
})();
