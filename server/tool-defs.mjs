// The page tools, defined once and independent of any agent SDK.
//
// A handler here knows nothing about which agent is calling it: it takes arguments,
// asks the page, and returns MCP content blocks. That is what lets the same
// definitions serve both the built-in Claude session and a standalone MCP server
// any other client can connect to.

export const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const failed = (err) => ({
  content: [{ type: "text", text: `The page could not answer: ${err.message}` }],
  isError: true,
});

/**
 * @param {(method: string, params?: unknown, timeout?: number) => Promise<any>} callPage
 * @param {(method: string, message: string) => void} report
 * @param {((path: string, needles: string[]) => any) | null} findInHtml
 * @param {((name: string, definingFile: string) => any) | null} countUsages
 * @param {((needles: string[]) => any[]) | null} findSourceCandidates
 */
export function toolDefinitions(
  callPage,
  report = () => {},
  findInHtml = null,
  countUsages = null,
  findSourceCandidates = null,
) {
  const ask = async (method, params) => {
    try {
      return text(await callPage(method, params));
    } catch (err) {
      report(method, err.message);
      return failed(err);
    }
  };

  return [
    {
      name: "read_selection",
      readOnly: true,
      always: true,
      description:
        "Read the user's current element selection. Returns each selected element in the order " +
        "it was picked (ref 1, 2, 3...) with its identifiers, geometry and box metrics, plus the " +
        "layout context of their nearest common ancestor, the pixel deltas between them, and the " +
        "viewport they are laid out in — which may be a simulated device size rather than the " +
        "browser window. Read this before proposing any change, and before answering any " +
        "question about position, alignment or spacing.",
      schema: {},
      run: () => ask("readSelection"),
    },
    {
      name: "capture",
      readOnly: true,
      always: true,
      description:
        "Screenshot the current selection (or the page) and return it as an image, with an " +
        "inventory of the elements inside the shot whose coordinates are relative to the " +
        "image's top-left corner. A still frame cannot show motion: use frames for a strip, and " +
        "delay to catch a state that exists only briefly. Call it again after a change to check " +
        "the result. It never waits for the network — what had not arrived is named in the " +
        "warnings.",
      schema: {
        ref: { type: "number", description: "Selection ref to capture" },
        region: {
          type: "object",
          description: "A viewport rectangle in CSS pixels, instead of an element",
          properties: { left: { type: "number" }, top: { type: "number" },
                        right: { type: "number" }, bottom: { type: "number" } },
        },
        inventory: { type: "boolean", description: "Include the element inventory (default true)" },
        delay: { type: "number", description: "Milliseconds to wait before the shutter, up to 15000" },
        frames: { type: "number", description: "Take a strip of up to 16 frames so motion is visible" },
        every: { type: "number", description: "Milliseconds between frames (default 300)" },
      },
      run: async (args) => {
        try {
          const budget = 20000 + (args.delay ?? 0) + (args.frames ?? 1) * (args.every ?? 300);
          const shot = await callPage("capture", args, budget);
          const strip = shot.frames ?? [{ png: shot.png, at: 0 }];
          const content = [];
          for (const [i, f] of strip.entries()) {
            if (strip.length > 1) {
              content.push({ type: "text", text: `Frame ${i + 1} of ${strip.length}, +${f.at}ms` });
            }
            content.push({ type: "image", data: f.png, mimeType: "image/png" });
          }
          if (shot.inventory) {
            content.push({
              type: "text",
              text:
                `Capture ${shot.width}x${shot.height}px at dpr ${shot.dpr}` +
                (shot.region ? ` of the region ${JSON.stringify(shot.region)}` : "") +
                `. Coordinates below are relative to the image's top-left corner.\n` +
                JSON.stringify(shot.inventory, null, 2),
            });
          }
          for (const w of shot.warnings ?? []) content.push({ type: "text", text: `Note: ${w}` });
          return { content };
        } catch (err) {
          report("capture", err.message);
          return failed(err);
        }
      },
    },
    {
      name: "capture_breakpoints",
      readOnly: true,
      description:
        "The same element at several viewport widths, one image per width. This captures an " +
        "element, not a rectangle, because a rectangle means something different at every " +
        "width. Needs the split-screen shell, which owns the resizable frame.",
      schema: {
        ref: { type: "number", description: "Selection ref of the element to follow" },
        selector: { type: "string", description: "A CSS selector, when nothing is selected" },
        widths: { type: "array", items: { type: "number" },
                  description: "Viewport widths in CSS pixels. Default 390, 768, 1440" },
      },
      run: async (args) => {
        try {
          const out = await callPage("captureBreakpoints", args, 60000);
          const content = [];
          for (const f of out.frames ?? []) {
            content.push({ type: "text", text: `At ${f.label}` });
            content.push({ type: "image", data: f.png, mimeType: "image/png" });
          }
          for (const note of out.notes ?? []) content.push({ type: "text", text: note });
          if (!content.length) content.push({ type: "text", text: "nothing could be captured at those widths" });
          return { content };
        } catch (err) {
          report("capture_breakpoints", err.message);
          return failed(err);
        }
      },
    },
    {
      name: "wait_for",
      readOnly: true,
      description:
        "Wait until the page is ready to look at, instead of guessing with a delay. Give a CSS " +
        "selector or some text; set gone:true to wait for it to disappear, which is how you wait " +
        "out a spinner. Returns as soon as the condition holds, with how long it waited.",
      schema: {
        selector: { type: "string", description: "A CSS selector to wait for" },
        text: { type: "string", description: "Text to wait for anywhere in the page" },
        gone: { type: "boolean", description: "Wait for it to disappear rather than appear" },
        timeout: { type: "number", description: "Give up after this many milliseconds (default 10000)" },
      },
      run: async (args) => {
        try {
          return text(await callPage("waitFor", args, (args.timeout ?? 10000) + 5000));
        } catch (err) {
          report("wait_for", err.message);
          return failed(err);
        }
      },
    },
    {
      name: "locate_source",
      readOnly: true,
      always: true,
      description:
        "Where an element came from in the codebase. Dev builds carry this: React and Svelte " +
        "record the file and line of each element, Vue records the component's file. Failing " +
        "that, the bridge searches the project's own source for the element's identifiers, and " +
        "failing that, the HTML it actually served. The reply names the confidence of the " +
        "answer — 'exact' (this element, file and line), 'component' (the right file, not " +
        "necessarily the right line — always true for Vue), or 'candidate' (a text match, in " +
        "source or served HTML) — and the evidence behind it. Treat anything short of 'exact' " +
        "as a lead to confirm, not a location to edit blind. When the resolved component is " +
        "also rendered elsewhere in the project, a 'reuse' field says how many other files — " +
        "see ask_choice for what to do about it. Use this before hunting with grep.",
      schema: {
        ref: { type: "number", description: "Selection ref; defaults to the first selected element" },
        selector: { type: "string", description: "A CSS selector, when nothing is selected" },
      },
      run: async (args) => {
        try {
          let found = await callPage("locateSource", args);

          if (found.confidence === "none") {
            const id = found.element ?? {};
            // Most distinctive first: a test id or id is close to unique, a class or
            // plain text is common enough to land on the wrong file.
            const needles = [
              id.testId && `data-testid="${id.testId}"`,
              id.id && `id="${id.id}"`,
              id.aria && `aria-label="${id.aria}"`,
              id.href,
              id.src,
              id.classes?.[0] && `class="${id.classes[0]}`,
              id.text,
            ].filter(Boolean);

            // The project's own source points at a file worth opening; served HTML
            // is often a rendered, sometimes-transformed artifact that isn't one.
            if (needles.length && findSourceCandidates) {
              const candidates = findSourceCandidates(needles);
              if (candidates.length) {
                found = {
                  ...found,
                  confidence: "candidate",
                  evidence: candidates.map((c) => ({
                    kind: "project-source-search",
                    file: c.file,
                    line: c.line,
                    matched: c.matched,
                    excerpt: c.excerpt,
                  })),
                  note:
                    "a text match in the project's own source, not confirmed by any framework " +
                    "metadata — read the file before trusting it",
                };
              }
            }

            if (found.confidence === "none" && findInHtml) {
              const guess = findInHtml(found.page?.path ?? "/", needles);
              if (guess.found) {
                found = {
                  ...found,
                  confidence: "candidate",
                  evidence: [{ kind: "served-html-search", line: guess.line, column: guess.column, matched: guess.matched, excerpt: guess.excerpt }],
                  note: "a text match in the HTML the bridge served, not a source file — confirm it before editing",
                };
              }
            }
          }

          if (found.component && found.source?.file && countUsages) {
            const reuse = countUsages(found.component, found.source.file);
            if (reuse && reuse.otherFiles > 0) {
              found = {
                ...found,
                reuse: {
                  otherFiles: reuse.otherFiles,
                  note:
                    `also rendered in ${reuse.otherFiles}${reuse.capped ? "+" : ""} other file(s) in this ` +
                    `project — a change to the component itself would affect it everywhere. If the request ` +
                    `doesn't already say which is meant, ask_choice before deciding.`,
                },
              };
            }
          }

          return text(found);
        } catch (err) {
          report("locate_source", err.message);
          return failed(err);
        }
      },
    },
    {
      name: "describe_styles",
      readOnly: true,
      always: true,
      description:
        "Which CSS rules actually style an element, in cascade order, with the stylesheet each " +
        "came from and which rule most likely wins each property by specificity, !important, " +
        "and source order. Computed values say what a property ended up as, never what set it — " +
        "the difference between editing the right line and editing one that loses the cascade. " +
        "This is not a full CSS engine: cascade layers, multiple stylesheet origins, CSS nesting, " +
        "and the exact specificity of :is()/:not() arguments are not modeled, so treat the named " +
        "winner as a strong hint, not a guarantee, when a selector uses those. Call this before " +
        "writing CSS to source.",
      schema: {
        ref: { type: "number", description: "Selection ref; defaults to the first selected element" },
        selector: { type: "string", description: "A CSS selector, when nothing is selected" },
        properties: { type: "array", items: { type: "string" },
                      description: "Narrow to these CSS properties" },
      },
      run: (args) => ask("describeStyles", args),
    },
    {
      name: "scan_region",
      readOnly: true,
      description:
        "List the visually significant elements inside a rectangle of the viewport, with their " +
        "identifiers and boxes. Use this when a capture raises a question about something you " +
        "cannot identify, instead of asking for a bigger screenshot.",
      schema: {
        x: { type: "number", description: "Left edge in CSS pixels" },
        y: { type: "number", description: "Top edge in CSS pixels" },
        w: { type: "number", description: "Width in CSS pixels" },
        h: { type: "number", description: "Height in CSS pixels" },
      },
      required: ["x", "y", "w", "h"],
      run: (args) => ask("scanRegion", args),
    },
    {
      name: "try_style",
      always: true,
      description:
        "Preview CSS on an element, named either by selection ref or by CSS selector. Applied " +
        "through a preview stylesheet above the page's own; nothing is written to disk and a " +
        "reload clears it. The element itself is untouched — its framework identity, state, " +
        "and event handlers all stay live — so this is a faithful preview of the real thing, " +
        "unlike try_markup. Show the user a change before they approve it. Do not use !important.",
      schema: {
        ref: { type: "number", description: "Selection ref" },
        selector: { type: "string", description: "A CSS selector, when nothing is selected" },
        declarations: { type: "string", description: "CSS declarations without braces" },
        also: { type: "string", description: "Optional extra full CSS rules" },
      },
      required: ["declarations"],
      run: (args) => ask("tryStyle", args),
    },
    {
      name: "try_markup",
      description:
        "Preview replacement markup for a selected element's subtree, by swapping in raw HTML " +
        "behind the framework's back. The original is kept in memory and restored on reset. This " +
        "is a visual mockup, not a faithful preview: the replacement carries no framework " +
        "identity, component state, or event bindings from React/Vue/Svelte, so anything " +
        "interactive in it will not behave like the real component even before a re-render " +
        "discards it outright. Good for showing layout or content changes; do not use it to " +
        "demonstrate behavior, and prefer try_style wherever a style change can express the " +
        "same thing.",
      schema: {
        ref: { type: "number", description: "Selection ref to replace" },
        html: { type: "string", description: "Replacement outerHTML" },
      },
      required: ["ref", "html"],
      run: (args) => ask("tryMarkup", args),
    },
    {
      name: "show_options",
      always: true,
      description:
        "Mount several alternatives for the user to flip between and pick one. Target by ref or " +
        "by CSS selector. Up to ten. The user's choice arrives as a new message from them, so " +
        "finish your turn after calling this and wait — unless your client cannot receive one, " +
        "in which case call await_choice next.",
      schema: {
        ref: { type: "number", description: "Selection ref the options apply to" },
        selector: { type: "string", description: "A CSS selector, when nothing is selected" },
        options: {
          type: "array",
          description: "Between 2 and 10 alternatives",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label naming what it does differently" },
              declarations: { type: "string", description: "CSS declarations without braces" },
              also: { type: "string", description: "Optional extra full CSS rules" },
            },
            required: ["label", "declarations"],
          },
        },
      },
      required: ["options"],
      run: (args) => ask("showOptions", args),
    },
    {
      name: "ask_choice",
      always: true,
      description:
        "Ask the user a plain multiple-choice question that has no visual difference to preview " +
        "— which approach, which file, a yes/no — unlike show_options, which is for comparing " +
        "CSS alternatives on the page itself. Renders as clickable buttons in their chat, so they " +
        "answer with a tap instead of retyping an option back to you. Their pick arrives as a new " +
        "message from them, so finish your turn after calling this and wait — unless your client " +
        "cannot receive one, in which case call await_answer next.",
      schema: {
        question: { type: "string", description: "The question, in one sentence" },
        options: {
          type: "array",
          description: "Between 2 and 6 short answers to choose from",
          items: { type: "string" },
        },
      },
      required: ["question", "options"],
      run: (args) => ask("askChoice", args),
    },
    {
      name: "reset_preview",
      description:
        "Discard the entire preview layer: drop all preview stylesheets, unmount any options, " +
        "and restore any replaced markup. The page returns to exactly its own styling.",
      schema: {},
      run: () => ask("resetPreview"),
    },
  ];
}
