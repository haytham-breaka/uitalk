// Everything that touches the page: identity, geometry, the preview layer, capture.
//
// Two rules hold throughout. Nothing here writes to disk, and every mutation
// goes through the preview layer so that reset() returns the page to exactly its
// own styling.

globalThis.UITalk = (() => {
  const REF_ATTR = "data-uitalk-ref";
  // A second handle, for elements the agent targets by selector rather than from
  // the user's selection — so a screenshot-only request can still be previewed.
  const TARGET_ATTR = "data-uitalk-target";
  const MAX_INVENTORY = 150;
  const MAX_AREA_PICK = 20;
  const MIN_BOX = 4;

  const picked = [];
  const history = [];
  const MAX_HISTORY = 40;
  const originals = new Map(); // ref -> replaced node, for try_markup
  let styleSheet = null; // the try_style sheet
  let optionSheets = []; // one per show_options alternative
  let optionState = null; // { ref, options, active }

  // ------------------------------------------------------------- identity

  const squash = (s) => s.trim().replace(/\s+/g, " ");

  function ownText(el) {
    let out = "";
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
    return squash(out);
  }

  function label(el) {
    return (ownText(el) || squash(el.textContent ?? "")).slice(0, 60) || undefined;
  }

  function dataAttrs(el) {
    const out = {};
    for (const { name, value } of el.attributes) {
      if (name.startsWith("data-uitalk-")) continue;
      if (name.startsWith("data-")) out[name] = value;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join("");
      const parent = node.parentElement;
      if (parent) {
        const twins = [...parent.children].filter((s) => s.tagName === node.tagName);
        if (twins.length > 1) part += `:nth-of-type(${twins.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // Identifiers a coding agent can actually grep for in source, not just
  // selectors that happen to match. Generated class names and utility classes
  // are near-useless as handles; text, id, test ids and aria labels are not.
  function identify(el) {
    const ref = el.getAttribute(REF_ATTR);
    const out = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: [...el.classList],
      testId: el.dataset.testid,
      aria: el.getAttribute("aria-label") || undefined,
      role: el.getAttribute("role") || undefined,
      name: el.getAttribute("name") || undefined,
      // The literal attribute, not el.href/el.src, which the DOM resolves to an
      // absolute URL — source files contain the string as written, not that.
      href: el.getAttribute("href") || undefined,
      src: el.getAttribute("src") || undefined,
      data: dataAttrs(el),
      text: label(el),
      selector: ref ? `[${REF_ATTR}="${ref}"]` : cssPath(el),
      sourceSelector: cssPath(el),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  // ------------------------------------------------------------ matched CSS

  // Computed styles say what the value ended up being; they never say which rule
  // decided it. That is the difference between editing the right line and editing a
  // line that loses the cascade, so the rules themselves have to be reported.

  // A selector list's commas, but only the ones not inside a nested (...) —
  // :is(.a, :not(.b, .c)) has one top-level argument, not four.
  const splitSelectorList = (list) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(list.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(list.slice(start));
    return parts.map((s) => s.trim()).filter(Boolean);
  };

  const higherSpecificity = (a, b) => {
    if (a[0] !== b[0]) return a[0] > b[0] ? a : b;
    if (a[1] !== b[1]) return a[1] > b[1] ? a : b;
    return a[2] >= b[2] ? a : b;
  };

  const specificity = (selector) => {
    // Good enough to order rules and explain why one won; not a full CSS engine —
    // cascade layers, multiple stylesheet origins, and CSS nesting aren't modeled,
    // and :is()/:not() nested more than one level deep falls back to the same
    // approximation as before (scored as an ordinary pseudo-class).
    let bare = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, ""); // :where() is always zero-specificity

    // :is()/:not() take the specificity of their most specific argument, not
    // the sum of everything inside plus one for the pseudo-class itself.
    let extra = [0, 0, 0];
    bare = bare.replace(/:(?:is|not)\((?:[^()]|\([^()]*\))*\)/g, (match) => {
      const inner = match.slice(match.indexOf("(") + 1, -1);
      const args = splitSelectorList(inner).map(specificity);
      const best = args.reduce(higherSpecificity, [0, 0, 0]);
      extra = [extra[0] + best[0], extra[1] + best[1], extra[2] + best[2]];
      return "";
    });

    const ids = (bare.match(/#[\w-]+/g) ?? []).length;
    const classes = (bare.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (bare.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
    return [ids + extra[0], classes + extra[1], types + extra[2]];
  };

  /** Where a stylesheet came from, including Vite's dev-time marker. */
  const sheetSource = (sheet) => {
    if (sheet.href) return sheet.href.replace(location.origin, "");
    const node = sheet.ownerNode;
    // Vite injects CSS as <style data-vite-dev-id="/abs/path/App.css">, which is the
    // real file even though the sheet has no href.
    return (
      node?.dataset?.viteDevId ??
      node?.getAttribute?.("data-styled") ??
      node?.dataset?.emotion ??
      (node?.tagName === "STYLE" ? "<style> in the document" : "unknown")
    );
  };

  const declarationsOf = (rule) => {
    const out = {};
    for (const prop of rule.style) out[prop] = rule.style.getPropertyValue(prop).trim();
    return out;
  };

  /** Properties this rule marks !important — these beat any non-important rule outright. */
  const importantPropsOf = (rule) => {
    const out = [];
    for (const prop of rule.style) if (rule.style.getPropertyPriority(prop) === "important") out.push(prop);
    return out;
  };

  function matchedRules(el, { properties = null, max = 40 } = {}) {
    const rules = [];
    const skipped = [];

    // Whether a conditional group applies right now. A rule inside an @media that
    // doesn't match this viewport, or an @supports the browser rejects, is still
    // worth reporting — it's the rule that *would* win on a phone — but it must not
    // be the winner here, or the agent gets sent to edit the phone-width rule to
    // change the desktop look. Anything this can't judge (an @container, a browser
    // without matchMedia) counts as active: wrongly excluding a rule is the worse
    // error.
    const applies = (rule) => {
      const kind = rule.constructor.name;
      if (kind === "CSSMediaRule" || rule.media) {
        const q = rule.conditionText ?? rule.media?.mediaText ?? "";
        if (!q || typeof matchMedia !== "function") return true;
        try {
          return matchMedia(q).matches;
        } catch {
          return true;
        }
      }
      if (kind === "CSSSupportsRule") {
        const q = rule.conditionText ?? "";
        if (!q || typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
        try {
          return CSS.supports(q);
        } catch {
          return true;
        }
      }
      return true; // @layer always applies; @container and the rest can't be judged from here
    };

    const walk = (list, context, active = true) => {
      for (const rule of list ?? []) {
        if (rule.cssRules && !rule.selectorText) {
          // @media, @supports, @layer: carry the condition down with the rules,
          // and whether it currently holds.
          const label = rule.conditionText ?? rule.media?.mediaText ?? rule.name ?? "";
          const kind = rule.constructor.name.replace("CSS", "").replace("Rule", "");
          walk(rule.cssRules, label ? [...context, `${kind} ${label}`] : context, active && applies(rule));
          continue;
        }
        if (!rule.selectorText) continue;

        // A rule's selector list matches if any part does; report the part that
        // did. A plain split(",") would also break on the comma inside a single
        // :is(#a, .b) argument list, turning it into two invalid fragments that
        // throw on .matches() and silently drop the whole rule.
        for (const part of splitSelectorList(rule.selectorText)) {
          // Strip pseudo-elements and state pseudo-classes so the rule that styles a
          // hover is still reported as applying to this element.
          const testable = part.replace(/::[\w-]+(\([^)]*\))?/g, "").replace(
            /:(hover|active|focus|focus-visible|focus-within|visited|target)\b/g, "");
          let hit = false;
          try {
            hit = testable.trim() ? el.matches(testable) : false;
          } catch {
            continue; // selectors we cannot test are not selectors we can report on
          }
          if (!hit) continue;

          const decls = declarationsOf(rule);
          const kept = properties
            ? Object.fromEntries(Object.entries(decls).filter(([k]) => properties.includes(k)))
            : decls;
          if (properties && !Object.keys(kept).length) break;

          const important = importantPropsOf(rule).filter((p) => p in kept);

          rules.push({
            selector: part,
            source: sheetSource(rule.parentStyleSheet ?? {}),
            context: context.length ? context : undefined,
            state: part !== testable ? part.slice(testable.length) : undefined,
            specificity: specificity(part),
            declarations: kept,
            important: important.length ? important : undefined,
            active: active ? undefined : false,
          });
          break;
        }
        if (rules.length >= max) return;
      }
    };

    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules, []);
      } catch {
        skipped.push(sheetSource(sheet)); // cross-origin: readable to the browser, not to us
      }
      if (rules.length >= max) break;
    }

    // Later and more specific wins, which is what decides where an edit belongs.
    // !important beats any non-important declaration outright; among peers of the
    // same importance, specificity is compared id, then class, then type, before
    // falling back to source order — skipping the type component would let a rule
    // like ".foo *" beat ".foo div" on order alone, even though it is less specific.
    const ordered = rules.map((r, i) => ({ ...r, order: i }));
    const winnerFor = {};
    for (const r of ordered) {
      for (const [prop, value] of Object.entries(r.declarations)) {
        const held = winnerFor[prop];
        const important = r.important?.includes(prop) ?? false;
        const heldImportant = held?.important ?? false;
        const beats =
          !held ||
          (important && !heldImportant) ||
          (important === heldImportant &&
            (r.specificity[0] > held.specificity[0] ||
              (r.specificity[0] === held.specificity[0] &&
                (r.specificity[1] > held.specificity[1] ||
                  (r.specificity[1] === held.specificity[1] &&
                    (r.specificity[2] > held.specificity[2] ||
                      (r.specificity[2] === held.specificity[2] && r.order > held.order)))))));
        if (beats && !r.state && r.active !== false) {
          winnerFor[prop] = { value, selector: r.selector, source: r.source, specificity: r.specificity, order: r.order, important };
        }
      }
    }

    const inline = el.getAttribute("style");
    const importantWinners = Object.keys(winnerFor).filter((k) => winnerFor[k].important);
    return {
      element: identify(el),
      rules: ordered,
      winners: Object.fromEntries(
        Object.entries(winnerFor).map(([k, v]) => [
          k,
          { value: v.value, from: `${v.selector} in ${v.source}`, important: v.important || undefined },
        ]),
      ),
      inline: inline || undefined,
      inaccessibleSheets: skipped.length ? [...new Set(skipped)] : undefined,
      note: inline
        ? importantWinners.length
          ? `an inline style attribute beats every rule here except the !important ` +
            `${importantWinners.length > 1 ? "properties" : "property"} reported in winners (${importantWinners.join(", ")})`
          : "an inline style attribute beats every rule here"
        : undefined,
    };
  }

  /** The computed value of specific properties, for comparing before and after. */
  function computedOf({ ref, selector, properties = [] } = {}) {
    let el = null;
    if (ref !== undefined && ref !== null) el = liveRef(ref);
    else if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        return null;
      }
    }
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(properties.map((p) => [p, cs.getPropertyValue(p).trim()]));
  }

  function describeStyles({ ref, selector, properties } = {}) {
    let el = null;
    if (ref !== undefined && ref !== null) el = requireLive(ref);
    else if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        throw new Error(`${selector} is not a valid CSS selector`);
      }
    } else if (picked.length) el = liveRef(1);
    if (!el) throw new Error("pass a selection ref or a CSS selector");
    return matchedRules(el, { properties: properties?.length ? properties : null });
  }

  // --------------------------------------------------------- source location

  // Dev builds already carry where an element came from; the mechanism differs per
  // framework and none of it requires touching the project. What is returned always
  // names its confidence and the evidence that produced it, because an agent told
  // "line 44" that is really a guess is worse off than one told to grep.
  function sourceOf(el) {
    for (let node = el; node; node = node.parentElement) {
      // React: the JSX transform records fileName/lineNumber, reachable via the fiber.
      const fiberKey = Object.keys(node).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
      );
      if (fiberKey) {
        for (let fiber = node[fiberKey]; fiber; fiber = fiber._debugOwner) {
          const src = fiber._debugSource ?? fiber._debugInfo?.[0]?.source;
          if (src?.fileName) {
            const exact = node === el;
            return {
              source: { file: src.fileName, line: src.lineNumber ?? null, column: src.columnNumber ?? null },
              confidence: exact ? "exact" : "component",
              evidence: [{ kind: "react-debug-source", exact }],
              component: fiber._debugOwner?.type?.name ?? fiber.type?.name ?? undefined,
            };
          }
        }
      }

      // Svelte stamps every element in dev.
      if (node.__svelte_meta?.loc?.file) {
        const loc = node.__svelte_meta.loc;
        const exact = node === el;
        return {
          source: { file: loc.file, line: loc.line ?? null, column: loc.column ?? null },
          confidence: exact ? "exact" : "component",
          evidence: [{ kind: "svelte-meta", exact }],
        };
      }

      // Vue knows the component's file, but never the line within it — that caps this
      // at "component" confidence even when the element itself is the exact match.
      const vue = node.__vueParentComponent ?? node.__vue_app__?._instance;
      const file = vue?.type?.__file;
      if (file) {
        return {
          source: { file, line: null, column: null },
          confidence: "component",
          evidence: [{ kind: "vue-component", exact: node === el }],
          component: vue.type.__name ?? undefined,
        };
      }
    }
    return null;
  }

  /** Where this element came from, or an honest account of why we cannot say. */
  function locateSource({ ref, selector } = {}) {
    let el = null;
    if (ref !== undefined && ref !== null) el = requireLive(ref);
    else if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        throw new Error(`${selector} is not a valid CSS selector`);
      }
    } else if (picked.length) el = liveRef(1);

    if (!el) throw new Error("pass a selection ref or a CSS selector");

    const element = identify(el);
    const found = sourceOf(el);
    if (!found) {
      return {
        element,
        source: null,
        confidence: "none",
        evidence: [],
        note:
          "this page carries no dev-time source metadata (a production build, or a framework " +
          "that does not emit it). Use the identifiers above to find it, or ask the bridge to " +
          "search the HTML it served.",
      };
    }

    const isVue = found.evidence[0]?.kind === "vue-component";
    const note =
      found.confidence === "exact"
        ? undefined
        : isVue
          ? "Vue names the component's file but not a line within it"
          : "the nearest ancestor that carries source info, not necessarily the element itself";

    return { element, ...found, note };
  }

  // ------------------------------------------------------------- geometry

  const box = (r, origin = { left: 0, top: 0 }) => ({
    x: Math.round(r.left - origin.left),
    y: Math.round(r.top - origin.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  });

  function depthFrom(el, root) {
    let d = 0;
    for (let n = el.parentElement; n && n !== root; n = n.parentElement) d++;
    return d;
  }

  function commonAncestor(els) {
    if (!els.length) return document.body;
    return els.reduce((a, b) => {
      let node = a;
      while (node && !node.contains(b)) node = node.parentElement;
      return node ?? document.body;
    });
  }

  function layoutOf(el) {
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      position: cs.position,
      flexDirection: /flex/.test(cs.display) ? cs.flexDirection : undefined,
      alignItems: /flex|grid/.test(cs.display) ? cs.alignItems : undefined,
      justifyContent: /flex|grid/.test(cs.display) ? cs.justifyContent : undefined,
      gap: /flex|grid/.test(cs.display) ? cs.gap : undefined,
      gridTemplateColumns: /grid/.test(cs.display) ? cs.gridTemplateColumns : undefined,
    };
  }

  const significant = (el, cs) =>
    !!ownText(el) ||
    /flex|grid/.test(cs.display) ||
    cs.backgroundImage !== "none" ||
    cs.backgroundColor !== "rgba(0, 0, 0, 0)" ||
    cs.borderStyle !== "none" ||
    ["IMG", "SVG", "BUTTON", "INPUT", "A", "TEXTAREA", "SELECT"].includes(el.tagName);

  function inventory(scope, origin, clip) {
    const out = [];
    for (const el of scope.querySelectorAll("*")) {
      if (uiHost && uiHost.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_BOX || r.height < MIN_BOX) continue;
      if (clip && (r.right < clip.left || r.left > clip.right || r.bottom < clip.top || r.top > clip.bottom)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      if (!significant(el, cs)) continue;
      const entry = { ...identify(el), depth: depthFrom(el, scope), at: box(r, origin) };
      if (/flex|grid/.test(cs.display)) entry.layout = layoutOf(el);
      out.push(entry);
      if (out.length >= MAX_INVENTORY) break;
    }
    return out;
  }

  // ------------------------------------------------------------- selection

  function stamp(el, ref) {
    el.setAttribute(REF_ATTR, String(ref));
  }

  // Clicking a selected element again deselects it. Refs are ordinal, so removing
  // one renumbers the rest: with 1,2,3 selected, dropping 2 makes 3 into 2. Any
  // preview was authored against the old numbering, so it is dropped first --
  // silently restyling a different element would be worse than clearing.
  function remember() {
    history.push(picked.slice());
    if (history.length > MAX_HISTORY) history.shift();
  }

  /** Step back to the selection as it was before the last change. */
  function undo() {
    if (!history.length) return null;
    const previewCleared = dropPreview();
    const prev = history.pop().filter((el) => el.isConnected); // a re-render may have replaced a node
    for (const el of picked) el.removeAttribute(REF_ATTR);
    picked.length = 0;
    prev.forEach((el, i) => {
      picked.push(el);
      stamp(el, i + 1);
    });
    return { action: "undone", total: picked.length, previewCleared, left: history.length };
  }

  function pick(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (uiHost && uiHost.contains(el)) return null;

    const at = picked.indexOf(el);
    if (at !== -1) return unpick(at + 1); // which remembers for itself

    remember();
    picked.push(el);
    stamp(el, picked.length);
    return { action: "selected", ref: picked.length, total: picked.length };
  }

  // Rubber-band selection. Only boxes fully inside the rectangle count, and of
  // those only the outermost: dragging across a card should select the card, not
  // the card plus every span inside it. Refs are assigned in document order,
  // which is the only ordering a rectangle implies.
  function boxOf(b) {
    return {
      left: Math.min(b.left, b.right),
      top: Math.min(b.top, b.bottom),
      right: Math.max(b.left, b.right),
      bottom: Math.max(b.top, b.bottom),
    };
  }

  const tooSmall = (a) => a.right - a.left < 8 || a.bottom - a.top < 8;

  /** The elements a rectangle would select, without selecting them. */
  /** Of a set, only those no other member contains. */
  const outermostOf = (set) => set.filter((el) => !set.some((other) => other !== el && other.contains(el)));

  /**
   * What a marquee takes: everything fully inside it, reduced to one level.
   *
   * Reducing to the outermost elements alone is not enough. A rectangle drawn around a
   * grid of cards encloses the grid too, so the grid wins and the user gets one
   * container instead of the cards they drew around. But a rectangle is the gesture for
   * picking *several* things — a single element is quicker to click — so when the set
   * comes out as one element, that element is the box the user drew around rather than
   * the thing they meant, and we step inside it. Repeats, so a chain of wrappers is
   * walked through rather than selected.
   *
   * `container: true` (Alt) stops at the outermost, for when the wrapper really is the
   * target.
   */
  function candidatesIn(box, opts = {}) {
    const area = boxOf(box);
    if (tooSmall(area)) return [];

    const inside = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (uiHost && uiHost.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_BOX || r.height < MIN_BOX) continue;
      if (r.left < area.left || r.top < area.top || r.right > area.right || r.bottom > area.bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      if (!significant(el, cs)) continue;
      inside.push(el);
    }

    let level = outermostOf(inside);
    if (opts.container) return level;

    // Depth is bounded by the document, but a guard keeps a malformed tree from
    // spinning here.
    for (let step = 0; level.length === 1 && step < 20; step++) {
      const parent = level[0];
      const within = outermostOf(inside.filter((el) => el !== parent && parent.contains(el)));
      if (!within.length) break;
      level = within;
    }
    return level;
  }

  /** What the marquee would take, as boxes to draw while the drag is in progress. */
  function previewArea(box, opts = {}) {
    return candidatesIn(box, opts).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        already: picked.includes(el),
        label: el.tagName.toLowerCase(),
      };
    });
  }

  function pickArea(box, opts = {}) {
    const area = boxOf(box);
    if (tooSmall(area)) {
      return { action: "selected", added: [], total: picked.length, note: "that rectangle was too small" };
    }

    const outermost = candidatesIn(box, opts);
    const fresh = outermost.filter((el) => !picked.includes(el));
    const added = [];

    if (fresh.length) remember();
    for (const el of fresh.slice(0, MAX_AREA_PICK)) {
      picked.push(el);
      stamp(el, picked.length);
      added.push(picked.length);
    }

    return {
      action: "selected",
      added,
      total: picked.length,
      skipped: Math.max(0, fresh.length - added.length),
      already: outermost.length - fresh.length,
    };
  }

  function unpick(ref) {
    if (!picked[ref - 1]) return null;

    remember();
    const previewCleared = dropPreview(); // while the numbering is still intact
    // A try_markup preview swaps the original element back in as a side effect
    // of dropping it (see resetPreview) — read picked[] again rather than the
    // node captured above, or the ref attribute gets removed from the now-
    // detached replacement while the restored original keeps a stale one.
    picked[ref - 1].removeAttribute(REF_ATTR);
    picked.splice(ref - 1, 1);
    picked.forEach((node, i) => stamp(node, i + 1));

    return { action: "deselected", ref, total: picked.length, previewCleared };
  }

  function dropPreview() {
    const active = Boolean(styleSheet || optionSheets.length || originals.size);
    if (active) resetPreview();
    return active;
  }

  function clearSelection() {
    if (picked.length) remember();
    const previewCleared = dropPreview(); // refs are about to vanish
    for (const el of picked) el.removeAttribute(REF_ATTR);
    const had = picked.length;
    picked.length = 0;
    return { cleared: had, previewCleared };
  }

  const byRef = (ref) => picked[ref - 1];

  // A re-render can replace the very node a ref points at without telling this
  // side at all — React frequently preserves a DOM node across a rerender, but
  // a conditional branch or a keyed list change can just as easily swap it out.
  // Treat a disconnected node as gone rather than operate on it: its geometry
  // reads as all zeros, its computed style as defaults, and a preview rule
  // built against it can never match anything visible again.
  const liveRef = (ref) => {
    const el = byRef(ref);
    return el && el.isConnected ? el : undefined;
  };

  /** liveRef(), but throws with a message that tells "never selected" apart
   * from "was selected, but the page changed underneath it" — the second is
   * worth a different instruction than the first. */
  function requireLive(ref) {
    const existed = byRef(ref);
    const el = liveRef(ref);
    if (el) return el;
    throw new Error(
      existed
        ? `ref ${ref} no longer exists in the page — the app re-rendered and replaced it. Ask the user to select it again.`
        : `no element is selected as ref ${ref}. Either ask the user to select it, or pass a CSS selector instead — ` +
          `scan_region returns one for every element it lists.`,
    );
  }

  function readSelection() {
    if (!picked.length) return { selected: 0, note: "Nothing is selected. Ask the user to pick an element." };

    const staleRefs = [];
    picked.forEach((el, i) => {
      if (!el.isConnected) staleRefs.push(i + 1);
    });
    const live = picked.filter((el) => el.isConnected);

    const ancestor = commonAncestor(live.length ? live : picked);
    const items = picked.map((el, i) => {
      if (!el.isConnected) {
        return {
          ref: i + 1,
          stale: true,
          note: "this element is no longer in the page — the app re-rendered and replaced it; ask the user to select it again",
        };
      }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        ref: i + 1,
        ...identify(el),
        rect: box(r),
        depth: depthFrom(el, ancestor),
        directChildOfAncestor: el.parentElement === ancestor,
        metrics: {
          margin: cs.margin,
          padding: cs.padding,
          alignSelf: cs.alignSelf,
          justifySelf: cs.justifySelf,
          position: cs.position,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
        },
        ownLayout: /flex|grid/.test(cs.display) ? layoutOf(el) : undefined,
        source: sourceOf(el) ?? undefined,
      };
    });

    const deltas = [];
    for (let i = 1; i < picked.length; i++) {
      if (!picked[0].isConnected || !picked[i].isConnected) continue; // no meaningful delta against a stale ref
      const a = picked[0].getBoundingClientRect();
      const b = picked[i].getBoundingClientRect();
      deltas.push({
        pair: `${i + 1} relative to 1`,
        topOffset: Math.round(b.top - a.top),
        leftOffset: Math.round(b.left - a.left),
        widthDiff: Math.round(b.width - a.width),
        heightDiff: Math.round(b.height - a.height),
        verticalGap: Math.round(b.top - a.bottom),
      });
    }

    return {
      selected: picked.length,
      page: pageContext(),
      items,
      ancestor: { ...identify(ancestor), layout: layoutOf(ancestor) },
      deltas,
      note: staleRefs.length
        ? `ref${staleRefs.length > 1 ? "s" : ""} ${staleRefs.join(", ")} no longer ${staleRefs.length > 1 ? "exist" : "exists"} ` +
          `in the page — the app re-rendered and replaced ${staleRefs.length > 1 ? "them" : "it"}; ask the user to ` +
          `select ${staleRefs.length > 1 ? "them" : "it"} again`
        : undefined,
    };
  }

  // --------------------------------------------------------- preview layer

  function sheet() {
    if (!styleSheet) {
      styleSheet = new CSSStyleSheet();
      adopt(styleSheet);
    }
    return styleSheet;
  }

  function adopt(s) {
    if (!document.adoptedStyleSheets.includes(s)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    }
  }

  function unadopt(s) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
  }

  // Preview rules have to beat the page's own CSS. Doubling the attribute
  // selector buys specificity 0,2,0 against a single class's 0,1,0 without
  // reaching for !important, which would outlive the preview in the user's
  // mental model of their own cascade.
  const dup = (attr, value) => `[${attr}="${value}"][${attr}="${value}"]`;

  let targetSeq = 0;
  const targeted = new Map(); // token -> { el, selector }

  /**
   * Either a selection ref or a CSS selector. A selector gets a preview handle
   * stamped on it so the same specificity trick applies, and so the rule keeps
   * matching even if the app rewrites the element's classes.
   */
  function resolveTarget({ ref, selector }) {
    if (ref !== undefined && ref !== null) {
      return { el: requireLive(ref), sel: dup(REF_ATTR, ref) };
    }

    if (selector) {
      let el;
      try {
        el = document.querySelector(selector);
      } catch {
        throw new Error(`${selector} is not a valid CSS selector`);
      }
      if (!el) throw new Error(`nothing on the page matches ${selector}`);
      if (uiHost && uiHost.contains(el)) throw new Error(`${selector} is part of the toolbar, not the page`);

      let token = el.getAttribute(TARGET_ATTR);
      if (!token) {
        token = String(++targetSeq);
        el.setAttribute(TARGET_ATTR, token);
        targeted.set(token, { el, selector });
      }
      return { el, sel: dup(TARGET_ATTR, token) };
    }

    throw new Error("pass either a selection ref or a CSS selector");
  }

  /**
   * A selector-targeted preview is attached to the page by a stamped attribute,
   * not by the selector itself — so a framework re-render that replaces the
   * element outright (rather than mutating it in place) leaves an already-
   * adopted preview rule matching nothing, silently, even though the CSS
   * selector the caller actually supplied would still match the new node fine.
   * Called before every RPC (see ui.js's serve()) rather than watched
   * continuously with a MutationObserver: cheap over the handful of targets
   * that are ever live at once, and the failure mode being guarded against is
   * "the preview goes quiet," not "acts on stale data" the way an unresolved
   * ref would — so reconciling lazily, on the next thing that touches the
   * page, is enough.
   */
  function reconcileTargets() {
    for (const [token, entry] of targeted) {
      if (entry.el.isConnected) continue;
      let fresh;
      try {
        fresh = document.querySelector(entry.selector);
      } catch {
        continue;
      }
      if (!fresh || fresh.hasAttribute(TARGET_ATTR)) continue; // gone, or already claimed by another target
      fresh.setAttribute(TARGET_ATTR, token);
      targeted.set(token, { el: fresh, selector: entry.selector });
    }
  }

  function ruleText(sel, declarations, also) {
    const body = declarations.replace(/^\s*\{|\}\s*$/g, "").trim().replace(/!important/gi, "");
    return `${sel} { ${body} }\n${also ?? ""}`;
  }

  function tryStyle({ ref, selector, declarations, also }) {
    const { el, sel } = resolveTarget({ ref, selector });
    dismissOptions();
    sheet().replaceSync(ruleText(sel, declarations, also));
    return { applied: true, target: identify(el), matchedBy: sel };
  }

  function tryMarkup({ ref, selector, html }) {
    const { el } = resolveTarget({ ref, selector });
    if (ref === undefined || ref === null) {
      throw new Error("try_markup needs a selection ref, because the original has to be restored by ref");
    }
    if (!originals.has(ref)) originals.set(ref, el);

    // A detached <div> parses html under whatever insertion-mode rules apply to
    // a generic element, which silently discards context-specific content: a
    // <tr> assigned via div.innerHTML loses its own tag entirely, because a
    // table row is not valid content there. Anchoring a Range at the element
    // being replaced gives the parser its real insertion context — inside a
    // <table>, a <select> — the same way the browser would parse it in place.
    const range = document.createRange();
    range.selectNode(el);
    const fragment = range.createContextualFragment(html);
    const elements = [...fragment.children];
    if (elements.length === 0) throw new Error("the html did not contain an element");
    if (elements.length > 1) {
      throw new Error(
        `the html has ${elements.length} top-level elements; try_markup replaces one element with one element`,
      );
    }
    const replacement = elements[0];

    stamp(replacement, ref);
    el.replaceWith(replacement);
    picked[ref - 1] = replacement;
    return {
      applied: true,
      ref,
      note:
        "a visual mockup, not a faithful preview: this markup was swapped in behind the framework's " +
        "back, so it carries no component state or event bindings, and a re-render will discard it",
    };
  }

  function showOptions({ ref, selector, options }) {
    const { el, sel } = resolveTarget({ ref, selector });
    dismissOptions();
    optionSheets = options.map((opt) => {
      const s = new CSSStyleSheet();
      s.replaceSync(ruleText(sel, opt.declarations, opt.also));
      return s;
    });
    optionState = { ref, selector, el, sel, options, active: 0 };
    adopt(optionSheets[0]);
    UITalk.onOptions?.(optionState);
    return { mounted: options.length, active: 1, labels: options.map((o) => o.label) };
  }

  // -1 is the page's own styling. Keeping it in the same sequence as the variants
  // means the arrows step through it too, and comparing against the original does
  // not mean discarding what is mounted.
  const ORIGINAL = -1;

  function flip(index) {
    if (!optionState) return null;
    const last = optionSheets.length - 1;
    let next = index;
    if (next < ORIGINAL) next = last;
    if (next > last) next = ORIGINAL;

    for (const s of optionSheets) unadopt(s);
    if (next >= 0) adopt(optionSheets[next]);

    optionState.active = next;
    UITalk.onOptions?.(optionState);
    return next;
  }

  function chosenOption() {
    if (!optionState || optionState.active < 0) return null; // the original is not a choice
    const opt = optionState.options[optionState.active];
    return {
      ref: optionState.ref ?? null,
      label: opt.label,
      declarations: opt.declarations,
      also: opt.also,
      element: identify(optionState.el),
      page: pageContext(),
    };
  }

  function dismissOptions() {
    for (const s of optionSheets) unadopt(s);
    optionSheets = [];
    optionState = null;
    UITalk.onOptions?.(null);
  }

  function resetPreview() {
    dismissOptions();
    if (styleSheet) {
      unadopt(styleSheet);
      styleSheet = null;
    }
    for (const [ref, original] of originals) {
      const current = picked[ref - 1];
      if (current && current.parentNode) {
        current.replaceWith(original);
        picked[ref - 1] = original;
        stamp(original, ref);
      }
    }
    originals.clear();
    for (const { el } of targeted.values()) el.removeAttribute(TARGET_ATTR);
    targeted.clear();
    return { reset: true };
  }

  // ----------------------------------------------------------- page context

  /**
   * Does this app push changes to the browser by itself? Vite, webpack and friends
   * do; a Flask or Django dev server restarts but leaves the page as it was, so an
   * edit is invisible until something reloads it.
   */
  function liveReload() {
    const has = (test) => {
      try {
        return Boolean(test());
      } catch {
        return false;
      }
    };
    if (has(() => document.querySelector('script[src*="@vite/client"], script[src*="/@vite/"]'))) return "vite";
    if (has(() => window.__vite_plugin_react_preamble_installed__ || window.$RefreshReg$)) return "vite";
    if (has(() => window.webpackHotUpdate || window.__webpack_hash__ || window.__webpack_require__)) return "webpack";
    if (has(() => window.__NEXT_DATA__ && window.next?.router)) return "next";
    if (has(() => document.querySelector('script[src*="livereload"], script[src*="browser-sync"]'))) return "livereload";
    if (has(() => window.__whmr || window.LiveReloadOptions)) return "livereload";
    return null;
  }

  const pageContext = () => ({
    url: location.href,
    path: location.pathname,
    search: location.search || undefined,
    hash: location.hash || undefined,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  });

  // ----------------------------------------------------------------- capture

  let uiHost = null;
  const setUiHost = (host) => {
    uiHost = host;
  };

  // requestAnimationFrame is paused in a background tab, so a bare await on it can
  // hang forever. Race it against a timer: the frame is a nicety, not a contract.
  const nextFrame = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 250);
    });


  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }

  // Our own panel and badges must not appear in the user's screenshot.
  async function withUiHidden(fn) {
    if (!uiHost) return fn();
    uiHost.style.visibility = "hidden";
    await nextFrame();
    try {
      return await fn();
    } finally {
      uiHost.style.visibility = "";
    }
  }

  // The smallest element that fully contains the rectangle. A region cannot be
  // cloned, so something has to be rasterized and cut down.
  function containerFor(area) {
    const cx = (area.left + area.right) / 2;
    const cy = (area.top + area.bottom) / 2;
    let start = document.elementFromPoint(cx, cy);
    if (!start || (uiHost && uiHost.contains(start))) start = document.body;

    for (let n = start; n; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.left <= area.left && r.top <= area.top && r.right >= area.right && r.bottom >= area.bottom) {
        return n;
      }
    }
    return document.body;
  }

  const normalise = (b) => ({
    left: Math.max(0, Math.min(b.left, b.right)),
    top: Math.max(0, Math.min(b.top, b.bottom)),
    right: Math.min(innerWidth, Math.max(b.left, b.right)),
    bottom: Math.min(innerHeight, Math.max(b.top, b.bottom)),
  });

  async function captureRegion(box, wantInventory) {
    const area = normalise(box);
    if (area.right - area.left < 8 || area.bottom - area.top < 8) {
      throw new Error("that region is too small to capture");
    }
    const container = containerFor(area);
    const shot = await withUiHidden(() => UITalkRaster.rasterize(container, { clip: area }));

    return {
      png: shot.png,
      width: shot.width,
      height: shot.height,
      dpr: devicePixelRatio,
      page: pageContext(),
      region: { x: Math.round(area.left), y: Math.round(area.top),
                w: Math.round(area.right - area.left), h: Math.round(area.bottom - area.top) },
      renderedFrom: identify(container),
      warnings: shot.warnings.length ? shot.warnings : undefined,
      inventory: wantInventory
        ? inventory(container, { left: area.left, top: area.top }, area)
        : undefined,
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * A still frame cannot show motion, and a page mid-load is a moving target too.
   * `delay` waits before the shutter, `frames`/`every` take a strip of them.
   */
  async function capture({ ref, region, inventory: wantInventory = true, delay = 0, frames = 1, every = 300 } = {}) {
    if (delay > 0) await sleep(Math.min(delay, 15000));

    const count = Math.max(1, Math.min(Math.round(frames), 16));
    if (count > 1) {
      const strip = [];
      const started = Date.now();
      for (let i = 0; i < count; i++) {
        // The renderer path cannot go as fast as the stream — cloning and
        // serializing dominates — so its floor is a frame at 60fps rather than 0.
        if (i) await sleep(Math.max(16, Math.min(every ?? 300, 5000)));
        const shot = await captureOnce({ ref, region, inventory: i === 0 && wantInventory });
        strip.push({ ...shot, at: Date.now() - started });
      }
      return {
        ...strip[0],
        frames: strip.map((f) => ({ png: f.png, at: f.at })),
        note: `${count} frames, ${every}ms apart`,
      };
    }

    return captureOnce({ ref, region, inventory: wantInventory });
  }

  async function captureOnce({ ref, region, inventory: wantInventory = true } = {}) {
    if (region) return captureRegion(region, wantInventory);

    // A stale ref (its node left the page in a rerender) is worth capturing the
    // page for anyway, rather than failing outright — but silently swapping in
    // a full-page shot for what was asked as "this element" would be exactly
    // the kind of quiet substitution this tool is supposed to call out.
    const staleRef = ref !== undefined && ref !== null && byRef(ref) && !byRef(ref).isConnected;
    const targets = ref ? [liveRef(ref)].filter(Boolean) : picked;
    const subject = targets.length ? (targets.length === 1 ? targets[0] : commonAncestor(targets)) : document.body;

    if (targets.length && !isVisible(targets[0])) {
      targets[0].scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await nextFrame();
    }

    const shot = await withUiHidden(() => UITalkRaster.rasterize(subject));
    const origin = subject.getBoundingClientRect();
    const warnings = [...shot.warnings];
    if (staleRef) {
      warnings.push(
        `ref ${ref} no longer exists in the page — the app re-rendered and replaced it, so this is a capture of ` +
          `the whole page instead. Ask the user to select it again.`,
      );
    }

    return {
      png: shot.png,
      width: shot.width,
      height: shot.height,
      dpr: devicePixelRatio,
      page: pageContext(),
      warnings: warnings.length ? warnings : undefined,
      inventory: wantInventory ? inventory(subject, { left: origin.left - 16, top: origin.top - 16 }, null) : undefined,
    };
  }

  /**
   * Wait for the page to be ready enough to look at, rather than guessing with a
   * delay. Resolves as soon as the condition holds.
   */
  function waitFor({ selector, text, gone = false, timeout = 10000 } = {}) {
    const deadline = Date.now() + Math.min(Math.max(timeout, 100), 60000);
    const started = Date.now();

    const hit = () => {
      if (selector) {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch {
          throw new Error(`${selector} is not a valid CSS selector`);
        }
        if (gone) return el ? null : { matched: "absent" };
        return el ? { matched: identify(el) } : null;
      }
      if (text) {
        const found = document.body.innerText.includes(text);
        if (gone) return found ? null : { matched: "absent" };
        return found ? { matched: "text" } : null;
      }
      throw new Error("pass a selector or some text to wait for");
    };

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        resolve({ ...value, waitedMs: Date.now() - started });
      };

      const look = () => {
        let result;
        try {
          result = hit();
        } catch (err) {
          observer.disconnect();
          clearInterval(poll);
          return reject(err);
        }
        if (result) finish({ found: true, ...result });
        else if (Date.now() > deadline) finish({ found: false, timedOut: true });
      };

      // Both: the observer catches a render the instant it lands, the interval
      // covers changes that mutate nothing observable, like an image finishing.
      const observer = new MutationObserver(look);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      const poll = setInterval(look, 150);
      look();
    });
  }

  /** Where an element sits right now, by ref or selector. Null when it is not there. */
  function rectOf({ ref, selector } = {}) {
    let el = null;
    if (ref !== undefined && ref !== null) el = liveRef(ref);
    else if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        throw new Error(`${selector} is not a valid CSS selector`);
      }
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    // Off-screen at this width: bring it into view before it is measured.
    if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center", behavior: "instant" });
    const after = el.getBoundingClientRect();
    return { left: after.left, top: after.top, width: after.width, height: after.height,
             element: identify(el) };
  }

  function scanRegion({ x, y, w, h }) {
    const clip = { left: x, top: y, right: x + w, bottom: y + h };
    return { region: { x, y, w, h }, page: pageContext(), elements: inventory(document.body, { left: x, top: y }, clip) };
  }

  return {
    // selection
    pick,
    pickArea,
    previewArea,
    unpick,
    undo,
    canUndo: () => history.length > 0,
    clearSelection,
    picked,
    byRef,
    readSelection,
    identify,
    locateSource,
    sourceOf,
    describeStyles,
    matchedRules,
    computedOf,
    // preview
    tryStyle,
    tryMarkup,
    showOptions,
    resetPreview,
    reconcileTargets,
    flip,
    chosenOption,
    dismissOptions,
    get optionState() {
      return optionState;
    },
    // capture / context
    capture,
    captureRegion,
    waitFor,
    rectOf,
    scanRegion,
    pageContext,
    liveReload,
    setUiHost,
    // filled in by ui.js
    onOptions: null,
  };
})();
