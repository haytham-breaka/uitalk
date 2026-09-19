// The bridge's own logic: settings, the instance registry, git snapshots, the
// proxy's injection and diagnosis, the message the agent receives, and every page
// tool's handler. None of it needs a browser, an agent, or a listening socket —
// which is why it had no coverage until now.

process.env.UITALK_IMPORT_ONLY = "1"; // importing the bridge must not start one

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
};

const sandbox = mkdtempSync(join(tmpdir(), "uitalk-server-check-"));
process.env.UITALK_HOME = join(sandbox, "home");
// The bridge reads its project root at import time; point it at the sandbox so a
// settings test cannot drop a file into the repository it is testing.
process.env.UITALK_PROJECT = join(sandbox, "bridge-project");
mkdirSync(process.env.UITALK_PROJECT, { recursive: true });

// ---------------------------------------------------------------- settings
{
  const settings = await import("../server/settings.mjs");
  const project = join(sandbox, "proj");
  mkdirSync(project, { recursive: true });

  const base = settings.load(project);
  check("defaults load with nothing on disk", base.compactAtPercent === 20 && base.autoCompact === true,
    JSON.stringify({ pct: base.compactAtPercent }));

  const clamp = settings.validate({ compactAtPercent: 999, contextTokens: 1, bogus: 1 });
  check("out-of-range numbers are clamped, not rejected", clamp.clean.compactAtPercent === 95,
    String(clamp.clean.compactAtPercent));
  check("a clamp is reported rather than applied silently",
    clamp.rejected.some((r) => /clamped/.test(r)), clamp.rejected.join("; "));
  check("an unknown key is refused", clamp.rejected.some((r) => /not a setting/.test(r)));
  check("a value below the floor is raised to it", clamp.clean.contextTokens === 20000,
    String(clamp.clean.contextTokens));

  // Booleans must be real JSON booleans: Boolean("false") is true, so a coerced
  // hand-edited "false" would flip the setting on — the opposite of the intent.
  const boolOk = settings.validate({ nativeCapture: false, autoCompact: true });
  check("a real JSON boolean passes through unchanged",
    boolOk.clean.nativeCapture === false && boolOk.clean.autoCompact === true, JSON.stringify(boolOk.clean));
  const boolStr = settings.validate({ nativeCapture: "false" });
  check("a string in a boolean field is refused, not read as truthy",
    !("nativeCapture" in boolStr.clean) && /must be true or false/.test(boolStr.rejected[0] ?? ""),
    JSON.stringify(boolStr));

  const choice = settings.validate({ reloadAfterEdit: "never" });
  check("a valid choice passes", choice.clean.reloadAfterEdit === "never");
  const badChoice = settings.validate({ reloadAfterEdit: "sometimes" });
  check("an invalid choice is refused with the options",
    !("reloadAfterEdit" in badChoice.clean) && /auto, always, never/.test(badChoice.rejected[0] ?? ""),
    badChoice.rejected[0]);

  const saved = settings.save(project, { compactAtPercent: 40, reloadAfterEdit: "always" });
  check("saving writes the project's own file", existsSync(join(project, ".uitalk.json")));
  check("and the merged view comes back", saved.settings.compactAtPercent === 40);
  check("the file holds only what was set",
    Object.keys(JSON.parse(readFileSync(join(project, ".uitalk.json"), "utf8"))).sort().join(",") ===
      "compactAtPercent,reloadAfterEdit");

  // env beats the project file, which beats the global one
  mkdirSync(join(sandbox, "home"), { recursive: true });
  writeFileSync(join(sandbox, "home", "settings.json"),
    JSON.stringify({ compactAtPercent: 11, replayLimit: 33 }), { flag: "w" });
  process.env.UITALK_COMPACT_AT_PERCENT = "77";
  const layered = settings.load(project);
  check("env wins over the project file", layered.compactAtPercent === 77, String(layered.compactAtPercent));
  check("the project file wins over the global one", layered.reloadAfterEdit === "always");
  check("the global file still supplies what nothing else set", layered.replayLimit === 33,
    String(layered.replayLimit));
  delete process.env.UITALK_COMPACT_AT_PERCENT;

  writeFileSync(join(project, ".uitalk.json"), "{ not json");
  check("a corrupt project file falls back rather than throwing",
    settings.load(project).compactAtPercent === 11, String(settings.load(project).compactAtPercent));
  rmSync(join(project, ".uitalk.json"));

  // Who answers the panel is a setting, so a project can commit its own choice.
  const agentOff = settings.validate({ agent: "off" });
  check("a project can choose to run with no built-in agent", agentOff.clean.agent === "off");
  const agentBad = settings.validate({ agent: "gpt" });
  check("and a mode that does not exist is refused with the list",
    !("agent" in agentBad.clean) && /builtin, adapter, opencode, off/.test(agentBad.rejected[0] ?? ""),
    agentBad.rejected[0]);

  const model = settings.validate({ agentModel: "  gemini-2.5-pro  " });
  check("a free-text setting is trimmed", model.clean.agentModel === "gemini-2.5-pro",
    JSON.stringify(model.clean.agentModel));
  const longModel = settings.validate({ agentModel: "x".repeat(200) });
  check("and capped, so a pasted essay cannot become a model name",
    !("agentModel" in longModel.clean) && /longer than/.test(longModel.rejected[0] ?? ""),
    longModel.rejected[0]);

  process.env.UITALK_AGENT = "adapter";
  check("the mode can be set for one run without editing a file",
    settings.load(project).agent === "adapter", settings.load(project).agent);
  delete process.env.UITALK_AGENT;

  // A key is not a setting: it must not be reachable through the settings surface,
  // because everything there is written to a committed file and sent to the page.
  const keyAsSetting = settings.validate({ apiKey: "sk-secret", agentApiKey: "sk-secret" });
  check("an API key cannot be smuggled in as a setting",
    Object.keys(keyAsSetting.clean).length === 0 && keyAsSetting.rejected.length === 2,
    keyAsSetting.rejected.join("; "));

  process.env.OPENAI_API_KEY = "sk-from-env";
  const fromEnv = settings.credential("openai");
  check("a provider's own variable is read", fromEnv.key === "sk-from-env" && fromEnv.from === "$OPENAI_API_KEY",
    fromEnv.from);
  process.env.UITALK_API_KEY = "sk-explicit";
  check("and UITALK_API_KEY takes precedence over it",
    settings.credential("openai").from === "$UITALK_API_KEY", settings.credential("openai").from);
  delete process.env.UITALK_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const written = settings.saveCredential("gemini", " key-on-disk ");
  check("a key written to disk lands in the uitalk home, not the project",
    written === join(sandbox, "home", "credentials.json") && !existsSync(join(project, "credentials.json")),
    written);
  check("only its owner can read it", (statSync(written).mode & 0o777) === 0o600,
    (statSync(written).mode & 0o777).toString(8));
  const fromFile = settings.credential("gemini");
  check("and it is read back trimmed, with its source named",
    fromFile.key === "key-on-disk" && fromFile.from === written, fromFile.from);
  check("a provider with no key anywhere reports none rather than guessing",
    settings.credential("anthropic").key === null, String(settings.credential("anthropic").key));
}

// ---------------------------------------------------------------- registry
{
  const registry = await import("../server/registry.mjs");
  registry.add({ pid: process.pid, port: 8400, appHost: "127.0.0.1", appPort: 5173, project: "/a" });
  check("an entry is listed while its process lives",
    registry.list().some((e) => e.pid === process.pid), JSON.stringify(registry.list()));

  registry.add({ pid: 999999, port: 8401, appHost: "127.0.0.1", appPort: 5174, project: "/b" });
  const live = registry.list();
  check("an entry whose process is gone is pruned", !live.some((e) => e.pid === 999999),
    `${live.length} live`);

  check("a bridge already serving an app is found",
    registry.servingApp("127.0.0.1", 5173)?.pid === process.pid);
  check("and one serving a different app is not", !registry.servingApp("127.0.0.1", 9999));

  registry.remove(process.pid);
  check("removing the last entry leaves no file behind", !existsSync(registry.registryPath),
    existsSync(registry.registryPath) ? readFileSync(registry.registryPath, "utf8") : "gone");
  check("listing an empty registry is empty, not an error", registry.list().length === 0);
}

// ---------------------------------------------------------- protocol boundary
{
  const { isFrame } = await import("../server/protocol.mjs");
  check("a plain object with a string kind is a frame", isFrame({ kind: "chat" }));
  check("null is not a frame", !isFrame(null));
  check("a bare primitive is not a frame", !isFrame(123) && !isFrame(true) && !isFrame("chat"));
  check("an array is not a frame", !isFrame([{ kind: "chat" }]));
  check("an object whose kind is not a string is not a frame", !isFrame({ kind: 123 }));
}

// -------------------------------------------------- MCP bridge discovery
// The standalone MCP server must connect only to the bridge serving *its* project
// — never fall back to an unrelated one — while an explicit port still wins.
{
  const registry = await import("../server/registry.mjs");
  const { bridgeUrl, canonical } = await import("../server/mcp.mjs");
  const { mkdtempSync, symlinkSync } = await import("node:fs");

  const projA = mkdtempSync(join(sandbox, "projA-"));
  const projB = mkdtempSync(join(sandbox, "projB-"));
  // Two live pids: the registry keys by pid and prunes dead ones, so both entries
  // need a process that is actually running to survive list().
  registry.add({ pid: process.pid, port: 8500, appHost: "127.0.0.1", appPort: 5173, project: projA });
  registry.add({ pid: process.ppid, port: 8501, appHost: "127.0.0.1", appPort: 5174, project: projB });

  check("with one matching project, discovery finds its bridge",
    bridgeUrl({ project: projA }) === "ws://127.0.0.1:8500/__uitalk/socket", bridgeUrl({ project: projA }));
  check("with several registered, the exact project still wins",
    bridgeUrl({ project: projB }) === "ws://127.0.0.1:8501/__uitalk/socket", bridgeUrl({ project: projB }));

  check("a trailing separator does not defeat the match",
    bridgeUrl({ project: projA + "/" }) === "ws://127.0.0.1:8500/__uitalk/socket", bridgeUrl({ project: projA + "/" }));

  const linkToA = join(sandbox, "link-to-a");
  symlinkSync(projA, linkToA);
  check("a symlink to the project resolves to the same bridge",
    bridgeUrl({ project: linkToA }) === "ws://127.0.0.1:8500/__uitalk/socket", bridgeUrl({ project: linkToA }));

  check("canonical normalizes a trailing separator away",
    canonical(projA + "/") === canonical(projA), `${canonical(projA + "/")} vs ${canonical(projA)}`);

  let noMatch = null;
  try { bridgeUrl({ project: join(sandbox, "not-registered") }); }
  catch (e) { noMatch = e.message; }
  check("no bridge for this project fails loudly instead of picking another",
    /no uitalk is running for/.test(noMatch ?? ""), noMatch);
  check("and the error names what is registered, to diagnose the mismatch",
    noMatch?.includes(projA) && noMatch?.includes(":8500"), noMatch);

  check("an explicit port wins outright, no registry lookup",
    bridgeUrl({ port: 9999, project: join(sandbox, "not-registered") }) === "ws://127.0.0.1:9999/__uitalk/socket",
    bridgeUrl({ port: 9999, project: join(sandbox, "not-registered") }));

  registry.remove(process.pid);
  registry.remove(process.ppid);
}

// ------------------------------------------------------------ usage counting
{
  const { countUsages } = await import("../server/usage.mjs");
  const proj = join(sandbox, "usage-project");
  mkdirSync(join(proj, "src", "components"), { recursive: true });
  mkdirSync(join(proj, "src", "legacy"), { recursive: true });
  mkdirSync(join(proj, "src", "pages"), { recursive: true });
  mkdirSync(join(proj, "node_modules", "some-lib"), { recursive: true });

  writeFileSync(join(proj, "src", "components", "Button.tsx"), "export function Button() { return <button/>; }\n");
  // a same-named component elsewhere in the project — its own usages must
  // never be counted as reuse of the real one
  writeFileSync(join(proj, "src", "legacy", "Button.tsx"), "export function Button() { return <button className='old'/>; }\n");

  writeFileSync(join(proj, "src", "pages", "Home.tsx"),
    "import { Button } from '../components/Button';\nexport default () => <div><Button/></div>;\n");
  writeFileSync(join(proj, "src", "pages", "Settings.tsx"),
    "import { Button } from '../components/Button';\nexport default () => <Button label=\"Save\"/>;\n");
  // imports and renders the *legacy* Button — a tag match, but not this component
  writeFileSync(join(proj, "src", "pages", "Old.tsx"),
    "import { Button } from '../legacy/Button';\nexport default () => <Button/>;\n");
  // mentions the tag with no import at all — a comment and a string, not usage
  writeFileSync(join(proj, "src", "pages", "Docs.tsx"),
    "// example: <Button label=\"Save\" />\nconst snippet = \"<Button/>\";\nexport default () => null;\n");
  // imports the real Button under a different local name — never contains the
  // literal text "<Button" anywhere, so this only confirms if imports are
  // resolved before searching for the original name, not after
  writeFileSync(join(proj, "src", "pages", "Renamed.tsx"),
    "import { Button as PrimaryButton } from '../components/Button';\nexport default () => <PrimaryButton/>;\n");
  writeFileSync(join(proj, "src", "pages", "DefaultAs.tsx"),
    "import Whatever from '../components/Button';\nexport default () => <Whatever/>;\n");
  writeFileSync(join(proj, "node_modules", "some-lib", "Button.tsx"), "<Button/><Button/><Button/>\n");

  mkdirSync(join(proj, "src", "vue"), { recursive: true });
  writeFileSync(join(proj, "src", "vue", "MyWidget.vue"), "<template><div/></template>\n");
  writeFileSync(join(proj, "src", "vue", "Card.vue"),
    "<script>import MyWidget from './MyWidget.vue'</script><template><my-widget/></template>\n");

  const found = countUsages(proj, "Button", "src/components/Button.tsx");
  check("counts a genuine import as confirmed", found?.confirmedFiles === 4, JSON.stringify(found));
  check("a same-named component elsewhere is not confirmed as reuse of this one",
    found?.confirmedFiles === 4, JSON.stringify(found)); // Old.tsx must not inflate this
  check("an unimported tag mention (comment, string, a different import) is possible, not confirmed",
    found?.possibleFiles === 2, JSON.stringify(found)); // Old.tsx + Docs.tsx
  check("node_modules is not counted at all", !JSON.stringify(found).includes("node_modules"), JSON.stringify(found));
  check("a small count is not reported as capped", found?.capped === false, JSON.stringify(found));

  check("a single-word name's kebab-case does not degenerate into the native HTML tag",
    countUsages(proj, "Button", "src/components/Button.tsx")?.confirmedFiles === 4);

  check("a renamed named import is confirmed, even though the file never contains the literal text '<Button'",
    !readFileSync(join(proj, "src", "pages", "Renamed.tsx"), "utf8").includes("<Button") && found?.confirmedFiles === 4,
    readFileSync(join(proj, "src", "pages", "Renamed.tsx"), "utf8"));
  check("a default import under an unrelated local name is confirmed the same way",
    !readFileSync(join(proj, "src", "pages", "DefaultAs.tsx"), "utf8").includes("<Button") && found?.confirmedFiles === 4,
    readFileSync(join(proj, "src", "pages", "DefaultAs.tsx"), "utf8"));

  check("a non-component-shaped name is not counted",
    countUsages(proj, "onClick", "src/components/Button.tsx") === null);
  check("a missing name is not counted", countUsages(proj, null, "src/components/Button.tsx") === null);
  check("a defining file outside the project is refused",
    countUsages(proj, "Button", "../../etc/passwd") === null);
  check("Vue's kebab-case template spelling is matched and its import confirmed",
    countUsages(proj, "MyWidget", "src/vue/MyWidget.vue")?.confirmedFiles === 1);
}

// -------------------------------------------------- project-source candidates
{
  const { findSourceCandidates } = await import("../server/candidates.mjs");
  const proj = join(sandbox, "candidates-project");
  mkdirSync(join(proj, "src", "components"), { recursive: true });
  mkdirSync(join(proj, "node_modules", "some-lib"), { recursive: true });

  writeFileSync(
    join(proj, "src", "components", "CheckoutButton.tsx"),
    'export function CheckoutButton() {\n  return <button data-testid="checkout" className="btn">Checkout</button>;\n}\n',
  );
  writeFileSync(join(proj, "src", "components", "Other.tsx"), "export const x = 'checkout'; // just a mention\n");
  writeFileSync(join(proj, "node_modules", "some-lib", "fake.tsx"), 'data-testid="checkout"\n');

  const hits = findSourceCandidates(proj, ['data-testid="checkout"', 'id="checkout"', "Checkout"]);
  check("the strongest identifier wins over a weaker one",
    hits.length === 1 && hits[0].file.includes("CheckoutButton"), JSON.stringify(hits));
  check("reports the matching line", hits[0]?.line === 2, JSON.stringify(hits));
  check("node_modules is excluded", !hits.some((h) => h.file.includes("node_modules")), JSON.stringify(hits));

  const fallback = findSourceCandidates(proj, ['id="not-there"', "Checkout"]);
  check("falls back to a weaker identifier when the strongest finds nothing everywhere",
    fallback.length >= 1 && fallback.every((h) => h.matched === "Checkout"), JSON.stringify(fallback));

  check("an empty needle list finds nothing", findSourceCandidates(proj, [undefined, null, ""]).length === 0);
}

// --------------------------------------------------------------- snapshots
{
  const snapshots = await import("../server/snapshots.mjs");
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });

  check("a directory that is not a repository says so", (await snapshots.isRepo(repo)) === false);
  check("and cannot be snapshotted", (await snapshots.snapshot(repo, "x")) === null);

  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "style.css"), ".a { color: red }\n");
  git("add", ".");
  git("commit", "-qm", "first");

  const snap = await snapshots.snapshot(repo, "before the edit");
  check("a clean tree snapshots to a restorable point", Boolean(snap?.ref), snap?.ref?.slice(0, 8));

  writeFileSync(join(repo, "style.css"), ".a { color: blue }\n");
  writeFileSync(join(repo, "extra.css"), ".b { color: green }\n");
  check("what changed since is reported", (await snapshots.changedSince(repo, snap)).length > 0);

  const out = await snapshots.revertTo(repo, snap);
  check("reverting names the files it restored", out.reverted.includes("style.css"),
    JSON.stringify(out.reverted));
  check("and the content really went back",
    readFileSync(join(repo, "style.css"), "utf8").includes("red"),
    readFileSync(join(repo, "style.css"), "utf8").trim());
  check("a file the agent added is left alone, not deleted",
    existsSync(join(repo, "extra.css")));

  const nothing = await snapshots.revertTo(repo, snap);
  check("reverting twice is harmless", nothing.reverted.length === 0, JSON.stringify(nothing));

  let refused = null;
  try { await snapshots.revertTo(repo, null); } catch (e) { refused = e.message; }
  check("reverting without a snapshot is refused", /no snapshot/.test(refused ?? ""), refused);

  // a dirty tree must still be restorable
  writeFileSync(join(repo, "style.css"), ".a { color: rebeccapurple }\n");
  const dirty = await snapshots.snapshot(repo, "dirty");
  writeFileSync(join(repo, "style.css"), ".a { color: black }\n");
  await snapshots.revertTo(repo, dirty);
  check("a snapshot of a dirty tree restores the dirty state",
    readFileSync(join(repo, "style.css"), "utf8").includes("rebeccapurple"),
    readFileSync(join(repo, "style.css"), "utf8").trim());

  // Once the agent's turn has ended, captureAfter() freezes what it actually did,
  // so revert can be scoped to that instead of "everything that now differs."
  writeFileSync(join(repo, "style.css"), ".a { color: red }\n");
  writeFileSync(join(repo, "kept.css"), ".k { color: gray }\n");
  git("add", ".");
  git("commit", "-qm", "baseline for the capture tests");

  {
    const snap0 = await snapshots.snapshot(repo, "agent creates a file in a new directory");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "NewButton.tsx"), "brand new\n");
    const snap = await snapshots.captureAfter(repo, snap0);

    const out = await snapshots.revertTo(repo, snap);
    check("a file the agent created is now cleaned up on revert",
      out.removed.includes(join("src", "NewButton.tsx")), JSON.stringify(out));
    check("and actually removed from disk", !existsSync(join(repo, "src", "NewButton.tsx")));
    check("its now-empty directory is cleaned up too", !existsSync(join(repo, "src")));
  }

  {
    const snap0 = await snapshots.snapshot(repo, "restyle style.css");
    writeFileSync(join(repo, "style.css"), ".a { color: blue }\n");
    const snap = await snapshots.captureAfter(repo, snap0); // the agent's turn ends here
    writeFileSync(join(repo, "style.css"), ".a { color: green } /* user kept editing */\n");

    const out = await snapshots.revertTo(repo, snap);
    check("a file edited again after the agent is skipped, not clobbered",
      out.skipped.includes("style.css") && !out.reverted.includes("style.css"), JSON.stringify(out));
    check("the user's later edit survives untouched",
      readFileSync(join(repo, "style.css"), "utf8").includes("user kept editing"));
  }

  {
    const snap0 = await snapshots.snapshot(repo, "restyle style.css again");
    writeFileSync(join(repo, "style.css"), ".a { color: teal }\n");
    const snap = await snapshots.captureAfter(repo, snap0);
    writeFileSync(join(repo, "kept.css"), ".k { color: cornflowerblue } /* unrelated work */\n");

    const out = await snapshots.revertTo(repo, snap);
    check("revert is scoped to files the agent touched, not everything since",
      out.reverted.includes("style.css") && !out.reverted.includes("kept.css"), JSON.stringify(out));
    check("an unrelated file the agent never touched is left alone",
      readFileSync(join(repo, "kept.css"), "utf8").includes("unrelated work"));
  }

  // A file that was already untracked before the approval, then edited by the
  // agent: git stash create never captured its contents and git diff ignores
  // untracked paths, so undo used to leave the agent's edit in place.
  {
    writeFileSync(join(repo, "Draft.css"), ".d { color: red } /* user's own */\n");
    const snap0 = await snapshots.snapshot(repo, "restyle a pre-existing untracked file");
    writeFileSync(join(repo, "Draft.css"), ".d { color: blue } /* agent */\n");
    const snap = await snapshots.captureAfter(repo, snap0);

    const out = await snapshots.revertTo(repo, snap);
    check("a pre-existing untracked file the agent edited is restored on undo",
      out.reverted.includes("Draft.css"), JSON.stringify(out));
    check("and its exact pre-agent contents come back",
      readFileSync(join(repo, "Draft.css"), "utf8") === ".d { color: red } /* user's own */\n",
      readFileSync(join(repo, "Draft.css"), "utf8").trim());
    unlinkSync(join(repo, "Draft.css"));
  }

  // The same, but the user edits it again after the agent's turn ends: undo must
  // not clobber the later edit.
  {
    writeFileSync(join(repo, "Draft2.css"), ".d { color: red }\n");
    const snap0 = await snapshots.snapshot(repo, "restyle then user re-edits");
    writeFileSync(join(repo, "Draft2.css"), ".d { color: blue } /* agent */\n");
    const snap = await snapshots.captureAfter(repo, snap0);
    writeFileSync(join(repo, "Draft2.css"), ".d { color: green } /* user kept editing */\n");

    const out = await snapshots.revertTo(repo, snap);
    check("an untracked file edited again after the agent is skipped, not clobbered",
      out.skipped.includes("Draft2.css") && !out.reverted.includes("Draft2.css"), JSON.stringify(out));
    check("the user's later edit to it survives",
      readFileSync(join(repo, "Draft2.css"), "utf8").includes("user kept editing"));
    unlinkSync(join(repo, "Draft2.css"));
  }
}

// ------------------------------------------------------------------- proxy
{
  const { createProxy, proxyUpgrade } = await import("../server/proxy.mjs");

  const app = createServer((req, res) => {
    if (req.url === "/nohead") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<body>bare</body>");
    }
    if (req.url === "/fragment") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("just text, no tags");
    }
    if (req.url === "/asset.js") {
      res.writeHead(200, { "content-type": "text/javascript", etag: 'W/"asset-1"' });
      return res.end("console.log(1)");
    }
    if (req.url === "/cached") {
      // The app's own HTML has not changed, so upstream is right to answer 304. The
      // injected tag is not covered by that validator, which is the whole problem.
      if (req.headers["if-none-match"] === 'W/"app-1"') {
        res.writeHead(304, { etag: 'W/"app-1"' });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html", etag: 'W/"app-1"' });
      return res.end("<html><head></head><body>cached</body></html>");
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'none'",
    });
    res.end("<html><head><title>t</title></head><body>hi</body></html>");
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const target = { host: "127.0.0.1", port: app.address().port };

  const injected = [];
  const proxy = createServer(createProxy({ target, onInject: (u) => injected.push(u), onHtml: () => {} }));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const at = (path) => `http://127.0.0.1:${proxy.address().port}${path}`;

  const home = await fetch(at("/"));
  const html = await home.text();
  check("the client is injected into html", html.includes('src="/__uitalk/client.js"'));
  check("it goes before </head> when there is one", html.indexOf("__uitalk/client.js") < html.indexOf("</head>"));
  check("a strict CSP is stripped from what we rewrite", !home.headers.get("content-security-policy"),
    home.headers.get("content-security-policy") ?? "removed");
  check("content-length matches the rewritten body",
    Number(home.headers.get("content-length")) === Buffer.byteLength(html), home.headers.get("content-length"));
  check("the injection is reported", injected.includes("/"));

  check("a page with no head is still injected", (await (await fetch(at("/nohead"))).text()).includes("__uitalk/client.js"));
  check("even a bare fragment is injected", (await (await fetch(at("/fragment"))).text()).includes("__uitalk/client.js"));

  const asset = await fetch(at("/asset.js"));
  check("non-html passes through untouched", (await asset.text()) === "console.log(1)");
  check("and an asset keeps its validator, so reloads stay cheap",
    asset.headers.get("etag") === 'W/"asset-1"', asset.headers.get("etag") ?? "stripped");

  // The bug this guards: the injected tag is not covered by upstream's ETag, so a
  // browser that revalidates gets 304, keeps its cached document, and goes on loading
  // whatever client path was current the first time it visited — across restarts and
  // renames. It presents as "the panel stopped appearing" with nothing in any log.
  const fresh = await fetch(at("/cached"));
  check("a rewritten document carries no upstream validator",
    !fresh.headers.get("etag"), fresh.headers.get("etag") ?? "none");
  check("and is marked not to be stored at all",
    /no-store/.test(fresh.headers.get("cache-control") ?? ""), fresh.headers.get("cache-control") ?? "(none)");

  const revalidated = await fetch(at("/cached"), { headers: { "if-none-match": 'W/"app-1"' } });
  const revalidatedBody = await revalidated.text();
  check("a conditional navigation gets a full injected document, never a bare 304",
    revalidated.status === 200 && revalidatedBody.includes("__uitalk/client.js"),
    `HTTP ${revalidated.status}, ${revalidatedBody.length} bytes`);

  const conditionalAsset = await fetch(at("/asset.js"), { headers: { "if-none-match": 'W/"asset-1"' } });
  check("an asset may still revalidate: only documents we rewrite are forced",
    conditionalAsset.status === 200, `HTTP ${conditionalAsset.status}`);

  app.close();
  const dead = await fetch(at("/"));
  const page = await dead.text();
  check("an app that is down produces a diagnosis, not a stack trace",
    dead.status === 502 && /No app on/.test(page), String(dead.status));
  check("the diagnosis carries the panel, so the tool does not vanish with the app",
    page.includes("__uitalk/client.js"));
  // Which advice it gives depends on whether anything else is answering nearby, so
  // assert that it gives a runnable command either way.
  check("and suggests a command to fix it", /npm run dev|uitalk --(dev|stop|app-port)/.test(page),
    (page.match(/<pre[^>]*>([^<]{0,60})/) ?? [])[1]);
  proxy.close();
  check("the upgrade forwarder is exported", typeof proxyUpgrade === "function");
}

// --------------------------------------------------- the bridge only binds loopback
{
  // Real end-to-end coverage of this would mean starting the actual bridge and
  // probing it from off-box, which this offline suite cannot do — and stripping CSP
  // headers the way the proxy test above confirms is only safe because nothing but
  // this machine can ever reach the bridge. That combination (CSP removal + writing
  // to the project + a coding agent) is exactly what makes an accidental network
  // bind dangerous, so the invariant is asserted directly against the source: there
  // must be exactly one .listen() call, and it must bind 127.0.0.1 literally, with
  // no CLI flag or setting anywhere that can widen it.
  const src = readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const listens = [...src.matchAll(/\.listen\(\s*[^,]+,\s*(['"])([^'"]*)\1/g)];
  check("the bridge has exactly one place it starts listening", listens.length === 1,
    String(listens.length));
  check("and it binds 127.0.0.1 literally, not a variable or 0.0.0.0",
    listens[0]?.[2] === "127.0.0.1", listens[0]?.[2]);

  const bin = readFileSync(new URL("../bin/uitalk", import.meta.url), "utf8");
  check("there is no --host (or similar) flag that could widen the bind",
    !/--host|--bind|--allow-network/.test(bin));
}

// -------------------------------------------- the message the agent receives
{
  const bridge = await import("../server/index.mjs");

  const plain = bridge.buildUserContent({
    text: "align 2 to 1", selectionCount: 2,
    page: { path: "/pricing", viewport: { w: 1440, h: 900, dpr: 2 } },
  });
  check("a plain message is a string with a header", typeof plain === "string" && plain.includes("/pricing"),
    String(plain).split("\n")[0]);
  check("the header carries the viewport and the selection count",
    /1440x900 @2x \| 2 element\(s\) selected/.test(plain), String(plain).split("\n")[0]);

  const mobile = bridge.buildUserContent({
    text: "why does this wrap", selectionCount: 0,
    page: { path: "/", viewport: { w: 390, h: 844, dpr: 2 },
            screen: { preset: "iPhone 14", width: 390, height: 844, orientation: "portrait", zoom: 0.5 } },
  });
  check("a simulated screen replaces the window viewport",
    /iPhone 14 390x844 portrait \(shown at 50%\)/.test(mobile), String(mobile).split("\n")[0]);

  const withShots = bridge.buildUserContent({
    text: "the flip", selectionCount: 0,
    page: { path: "/", viewport: { w: 800, h: 600, dpr: 1 } },
    shots: [
      { png: "AAAA", label: "frame 1", triggeredBy: [{ at: 0, element: { selector: "button.card" } }] },
      { png: "BBBB", label: "frame 2" },
    ],
  });
  check("screenshots arrive as image blocks", Array.isArray(withShots) &&
    withShots.filter((b) => b.type === "image").length === 2, `${withShots.length} blocks`);
  check("each image is introduced by its label",
    withShots.some((b) => b.type === "text" && /Screenshot 1 of 2: frame 1/.test(b.text)));
  check("the interaction timeline rides with the first",
    withShots.some((b) => b.type === "text" && /\+0ms clicked button\.card/.test(b.text)),
    withShots.find((b) => /timeline/.test(b.text ?? ""))?.text?.slice(-60));

  // the served-html fallback for pages with no framework metadata
  bridge.servedHtml.set("/about", "<html>\n<body>\n<button data-testid=\"go\">Go</button>\n</body>\n</html>");
  const hit = bridge.findInServedHtml("/about", ['data-testid="go"']);
  check("an element is found in the html we served", hit.found && hit.line === 3, JSON.stringify(hit));
  check("and the line is quoted back", /data-testid/.test(hit.excerpt ?? ""), hit.excerpt);
  check("a miss says why", bridge.findInServedHtml("/about", ["nope"]).found === false);
  check("a path never served says so", /nothing served/.test(bridge.findInServedHtml("/never", ["x"]).reason ?? ""));

  // transcript and context accounting
  bridge.transcript.length = 0;
  bridge.record("me", "first");
  bridge.record("agent", "reply");
  bridge.record("me", "");
  check("the transcript keeps finished messages", bridge.transcript.length === 2,
    `${bridge.transcript.length} entries`);
  check("and drops empty ones", !bridge.transcript.some((e) => e.text === ""));

  bridge.resetContextMeter();
  bridge.noteUsage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, cache_read_input_tokens: 900 } } });
  check("context is the whole prompt, not just fresh tokens", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.noteUsage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5000 } } });
  check("the same message id is not counted twice", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.noteUsage({ type: "assistant", parent_tool_use_id: "t1",
    message: { id: "m2", usage: { input_tokens: 90000 } } });
  check("a subagent's context is its own, not ours", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.resetContextMeter();
  check("resetting clears the meter", bridge.context.tokens === 0 && bridge.context.percent === 0);
}

// --------------------------------------------------------------- page tools
{
  const { createPageServer } = await import("../server/page-tools.mjs");
  const calls = [];
  const failures = [];
  let answer = { ok: true };
  let htmlGuess = { found: true, line: 7, column: 1, matched: "go", excerpt: "<button>" };
  let usageAnswer = null;
  let sourceCandidates = [];

  const srv = createPageServer(
    async (method, params) => {
      calls.push({ method, params });
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(method, params) : answer;
    },
    (method, message) => failures.push({ method, message }),
    (path, needles) => (typeof htmlGuess === "function" ? htmlGuess(path, needles) : htmlGuess),
    (name, file) => (typeof usageAnswer === "function" ? usageAnswer(name, file) : usageAnswer),
    (needles) => (typeof sourceCandidates === "function" ? sourceCandidates(needles) : sourceCandidates),
  );

  const tools = srv.instance._registeredTools;
  const run = (name, args = {}) => tools[name].handler(args, {});

  check("every page tool is registered", Object.keys(tools).length === 12, Object.keys(tools).length);
  check("each tool carries a description the agent can choose from",
    Object.values(tools).every((t) => typeof t.description === "string" && t.description.length > 40),
    Object.entries(tools).find(([, t]) => (t.description ?? "").length <= 40)?.[0] ?? "all described");

  answer = { selected: 2 };
  const sel = await run("read_selection");
  check("read_selection passes the page's answer through",
    /"selected": 2/.test(sel.content[0].text), sel.content[0].text.slice(0, 40));

  answer = { png: "AAAA", width: 10, height: 10, dpr: 2, inventory: [] };
  const shot = await run("capture", { inventory: true });
  check("capture returns an image block", shot.content.some((b) => b.type === "image"));
  check("with the inventory beside it", shot.content.some((b) => b.type === "text" && /Coordinates/.test(b.text)));

  answer = { png: "A", frames: [{ png: "A", at: 0 }, { png: "B", at: 40 }], width: 4, height: 4, dpr: 1 };
  const strip = await run("capture", { frames: 2, every: 40 });
  check("a strip becomes one image block per frame",
    strip.content.filter((b) => b.type === "image").length === 2);
  check("each frame is introduced with its offset",
    strip.content.some((b) => b.type === "text" && /Frame 2 of 2, \+40ms/.test(b.text)));
  check("a strip is given a longer budget than a single shot",
    calls.at(-1).method === "capture", calls.at(-1).method);

  answer = { confidence: "exact", source: { file: "/src/App.jsx", line: 44, column: null }, evidence: [{ kind: "react-debug-source", exact: true }] };
  const loc = await run("locate_source", { ref: 1 });
  check("locate_source reports the confidence that answered", /"confidence": "exact"/.test(loc.content[0].text));

  // no framework metadata: the project's own source is searched before the
  // served HTML is, since it points at a file worth opening
  answer = { confidence: "none", source: null, evidence: [], element: { testId: "checkout" }, page: { path: "/about" } };
  sourceCandidates = [{ file: "src/components/CheckoutButton.tsx", line: 5, matched: 'data-testid="checkout"', excerpt: "<button data-testid=\"checkout\">" }];
  const viaSource = await run("locate_source", { ref: 1 });
  check("the project's own source is preferred over the served html",
    /"confidence": "candidate"/.test(viaSource.content[0].text) && /"kind": "project-source-search"/.test(viaSource.content[0].text),
    viaSource.content[0].text);
  check("the served html is not even consulted once source candidates answer",
    !/"kind": "served-html-search"/.test(viaSource.content[0].text), viaSource.content[0].text);
  sourceCandidates = [];

  const fallback = await run("locate_source", { ref: 1 });
  check("with no source match either, it falls back to the served html",
    /"confidence": "candidate"/.test(fallback.content[0].text), fallback.content[0].text.slice(0, 80));
  check("carrying the served-html evidence that answered it",
    /"kind": "served-html-search"/.test(fallback.content[0].text), fallback.content[0].text);

  htmlGuess = { found: false, reason: "none of 1 identifiers appear in the served HTML" };
  const stillNone = await run("locate_source", { ref: 1 });
  check("and stays 'none' when neither the source nor the served html has a match",
    /"confidence": "none"/.test(stillNone.content[0].text), stillNone.content[0].text.slice(0, 80));
  htmlGuess = { found: true, line: 7, column: 1, matched: "go", excerpt: "<button>" };

  // a resolved component that is reused elsewhere is flagged, so the agent can
  // ask about scope instead of silently rippling a change through every instance
  answer = {
    confidence: "exact",
    source: { file: "src/components/Button.tsx", line: 12, column: 3 },
    evidence: [{ kind: "react-debug-source", exact: true }],
    component: "Button",
  };
  usageAnswer = { confirmedFiles: 6, possibleFiles: 0, capped: false };
  const reused = await run("locate_source", { ref: 1 });
  check("a component confirmed elsewhere carries a reuse field",
    /"reuse"/.test(reused.content[0].text) && /"confirmedFiles": 6/.test(reused.content[0].text),
    reused.content[0].text);

  usageAnswer = { confirmedFiles: 0, possibleFiles: 3, capped: false };
  const possibleOnly = await run("locate_source", { ref: 1 });
  check("a component with only unconfirmed matches still reports them, but distinctly",
    /"reuse"/.test(possibleOnly.content[0].text) && /"possibleFiles": 3/.test(possibleOnly.content[0].text) &&
      /"confirmedFiles": 0/.test(possibleOnly.content[0].text),
    possibleOnly.content[0].text);

  usageAnswer = { confirmedFiles: 0, possibleFiles: 0, capped: false };
  const notReused = await run("locate_source", { ref: 1 });
  check("a component that is not reused at all carries no reuse field",
    !/"reuse"/.test(notReused.content[0].text), notReused.content[0].text);

  answer = { confidence: "exact", source: { file: "src/App.jsx", line: 44, column: null }, evidence: [{ kind: "react-debug-source", exact: true }] };
  usageAnswer = () => { throw new Error("countUsages should not be called without a resolved component"); };
  const noComponent = await run("locate_source", { ref: 1 });
  check("an element with no resolved component is never checked for reuse",
    !/"reuse"/.test(noComponent.content[0].text) && !noComponent.isError, noComponent.content[0].text);
  usageAnswer = null;

  answer = { frames: [{ png: "A", at: 390, label: "390px · 300×100" }], notes: ["1440px: the element is not present"] };
  const bp = await run("capture_breakpoints", { ref: 1, widths: [390, 1440] });
  check("breakpoints return one image per width", bp.content.filter((b) => b.type === "image").length === 1);
  check("and a note for a width where the element was missing",
    bp.content.some((b) => b.type === "text" && /not present/.test(b.text)));

  answer = new Error("the app frame is not ready");
  const broken = await run("try_style", { ref: 1, declarations: "color: red" });
  check("a page that cannot answer produces an error result, not a throw", broken.isError === true);
  check("the message reaches the agent", /not ready/.test(broken.content[0].text), broken.content[0].text);
  check("and is reported so the panel can show it",
    failures.some((f) => f.method === "tryStyle" && /not ready/.test(f.message)),
    JSON.stringify(failures.at(-1)));

  answer = { ok: true };
  const noneShot = await run("capture", { inventory: false });
  check("a capture with no image still answers rather than hanging", Array.isArray(noneShot.content));
}

// ------------------------------------------------- the bridge's frame router
{
  const bridge = await import("../server/index.mjs");

  // A stand-in for a connected page: the router only needs on/send/readyState.
  const makePage = () => {
    const sent = [];
    const handlers = {};
    const ws = {
      readyState: 1,
      OPEN: 1,
      sent,
      on: (type, fn) => (handlers[type] = fn),
      send: (data) => sent.push(JSON.parse(data)),
      deliver: (frame) => handlers.message?.(Buffer.from(JSON.stringify(frame))),
      deliverRaw: (bytes) => handlers.message?.(Buffer.from(bytes)),
      close: () => handlers.close?.(),
    };
    bridge.wss.emit("connection", ws, {});
    return ws;
  };

  const page = makePage();
  const ready = page.sent.find((f) => f.kind === "ready");
  check("a connecting page is greeted with its settings and build", Boolean(ready?.settings && ready?.build),
    JSON.stringify({ build: ready?.build, hasSettings: Boolean(ready?.settings) }));
  check("and told which project it is attached to", typeof ready?.project === "string");

  bridge.transcript.length = 0;
  bridge.record("me", "earlier message");
  const second = makePage();
  check("a page joining later is replayed what it missed",
    second.sent.some((f) => f.kind === "replay" && f.entries.length === 1),
    JSON.stringify(second.sent.map((f) => f.kind)));

  // a chat frame is recorded with what rode along
  bridge.transcript.length = 0;
  page.deliver({ kind: "chat", text: "make it bolder", selectionCount: 2,
    page: { path: "/", viewport: { w: 1, h: 1, dpr: 1 } },
    shots: [{ png: "A", label: "one" }] });
  check("a chat message is recorded for replay", bridge.transcript.length === 1);
  check("and the record says what was attached",
    /1 screenshot, 2 element\(s\) selected/.test(bridge.transcript[0].text),
    bridge.transcript[0].text.split("\n")[1]);

  // announcing makes a page the active one, which is where page calls go
  const older = page;
  const newer = makePage();
  newer.deliver({ kind: "focus", url: "http://127.0.0.1:8400/", visible: true });
  older.sent.length = 0;
  newer.sent.length = 0;
  const inflight = bridge.callPage("readSelection", {}, 500);
  check("a page call goes to the tab that announced itself last",
    newer.sent.some((f) => f.kind === "rpc") && !older.sent.some((f) => f.kind === "rpc"),
    `newer ${newer.sent.length}, older ${older.sent.length}`);

  const rpc = newer.sent.find((f) => f.kind === "rpc");
  newer.deliver({ kind: "rpc_result", id: rpc.id, result: { selected: 3 } });
  check("and its answer settles the call", (await inflight).selected === 3);

  const timing = bridge.callPage("capture", {}, 60).then(() => null, (e) => e.message);
  check("a page that never answers times out rather than hanging",
    /timed out/.test(await timing), await timing);

  newer.deliver({ kind: "rpc_result", id: 99999, result: { stray: true } });
  check("an answer to a call that already timed out is ignored", true);

  page.deliver({ kind: "nonsense" });
  check("an unknown frame is ignored rather than crashing the bridge", true);

  // Valid JSON that is not a protocol frame — a bare null, primitive, or array —
  // must be dropped at the edge, not reach a handler that reads .kind on it. A
  // literal `null` used to throw straight out of the message handler.
  for (const bytes of ["null", "true", "123", '"a string"', "[]", "{}", '{"kind":123}', "not json{"]) {
    page.deliverRaw(bytes);
  }
  check("malformed frames are dropped without crashing the bridge", true);
  // ...and a valid frame delivered right after still works, so the connection
  // was not poisoned by the junk before it.
  bridge.transcript.length = 0;
  page.deliver({ kind: "chat", text: "still alive" });
  check("a valid frame after malformed ones is still handled",
    bridge.transcript.some((t) => t.text?.includes("still alive")), JSON.stringify(bridge.transcript));

  // settings arrive from the panel and come back merged
  newer.sent.length = 0;
  page.deliver({ kind: "settings", patch: { compactAtPercent: 44, bogus: 1 } });
  await new Promise((r) => setTimeout(r, 50));
  const saved = newer.sent.find((f) => f.kind === "settings");
  check("a settings change is applied and broadcast", saved?.settings?.compactAtPercent === 44,
    JSON.stringify(saved?.settings?.compactAtPercent));
  check("and what was refused is said out loud", saved?.rejected?.some((r) => /not a setting/.test(r)),
    JSON.stringify(saved?.rejected));

  // revert with nothing to go back to must not pretend
  newer.sent.length = 0;
  page.deliver({ kind: "revert" });
  await new Promise((r) => setTimeout(r, 80));
  check("reverting with no snapshot says so rather than failing silently",
    newer.sent.some((f) => f.kind === "reverted" && f.ok === false),
    JSON.stringify(newer.sent.find((f) => f.kind === "reverted")));

  // a page that disconnects mid-call leaves a promise with nothing to answer it —
  // that should fail fast, not sit until the generic timeout
  {
    newer.sent.length = 0;
    newer.deliver({ kind: "focus", url: "http://127.0.0.1:8400/", visible: true }); // re-activate it
    const inflight2 = bridge.callPage("capture", {}, 5000).then(() => null, (e) => e.message);
    newer.close();
    const msg = await inflight2;
    check("a call rejects immediately when its page disconnects, not after the timeout",
      /disconnected/.test(msg ?? ""), msg);
  }

  // New Session (or Compact now) used to be able to fire while an ordinary turn was
  // still open: the SDK's next "result" event — belonging to that real turn — got
  // mistaken for the internal ask's own answer, silently dropping the real turn's
  // transcript entry, its turn_end, and its undo-safety capture.
  {
    const p2 = makePage();
    p2.deliver({ kind: "focus", url: "http://127.0.0.1:8400/", visible: true });
    p2.sent.length = 0;
    bridge.setSessionForTest({
      mode: "builtin",
      label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    bridge.transcript.length = 0;

    bridge.pushToAgent("what changed?"); // a real, ordinary turn starts
    bridge.relay({ type: "assistant", message: { content: [] } });
    bridge.relay({ type: "stream_event", event: { delta: { type: "text_delta", text: "I edited Button.tsx." } } });

    const cleared = bridge.clearSession(); // New Session, while that turn is still open
    cleared.catch(() => {}); // its own internal ask never gets a real answer in this test

    bridge.relay({ type: "result", subtype: "success" }); // the real turn finally finishes
    await new Promise((r) => setTimeout(r, 20));

    check("the real turn's completion still reaches the panel despite the concurrent New Session",
      p2.sent.some((f) => f.kind === "turn_end"), JSON.stringify(p2.sent.map((f) => f.kind)));
    check("and is still recorded, rather than being swallowed by the internal ask",
      bridge.transcript.some((t) => t.role === "agent" && /edited Button/.test(t.text)),
      JSON.stringify(bridge.transcript));

    bridge.setSessionForTest(null);
    p2.close();
  }

  // undo must not race a turn that is still writing: postCaptured only appears
  // once the turn that made a change has genuinely finished (see snapshots.mjs).
  {
    execFileSync("git", ["init", "-q"], { cwd: process.env.UITALK_PROJECT });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: process.env.UITALK_PROJECT });
    execFileSync("git", ["config", "user.name", "t"], { cwd: process.env.UITALK_PROJECT });
    writeFileSync(join(process.env.UITALK_PROJECT, "style.css"), ".a{color:red}\n");
    execFileSync("git", ["add", "."], { cwd: process.env.UITALK_PROJECT });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: process.env.UITALK_PROJECT });

    page.sent.length = 0;
    page.deliver({ kind: "approval", label: "make it bold", ref: 1, declarations: "font-weight:700", element: {} });
    await new Promise((r) => setTimeout(r, 30));

    page.sent.length = 0;
    page.deliver({ kind: "revert" });
    await new Promise((r) => setTimeout(r, 30));
    const refused = page.sent.find((f) => f.kind === "reverted");
    check("undo refuses while the approved edit's turn is still open, rather than racing it",
      refused?.ok === false && /hasn't finished/.test(refused.text ?? ""), JSON.stringify(refused));

    await bridge.clearSession(); // drop lastChange before the tests that follow
  }

  const openBefore = bridge.clients.size;
  page.close();
  check("a page that disconnects is forgotten", bridge.clients.size === openBefore - 1,
    `${openBefore} -> ${bridge.clients.size}`);

  for (const c of [...bridge.clients]) bridge.clients.delete(c);
  let noPage = null;
  await bridge.callPage("readSelection", {}, 50).catch((e) => (noPage = e.message));
  check("with no page connected a call is refused immediately", /no page is connected/.test(noPage ?? ""),
    noPage);

  // -------------------------------------------- approval / undo core contract
  //
  // preview -> approve -> agent edits source -> undo safely restores exactly
  // that change. The snapshot that makes undo possible is a real subprocess
  // call (see snapshots.mjs), not something that resolves before the approval
  // handler returns — so nothing that could let an agent start editing may run
  // ahead of it.
  execFileSync("git", ["init", "-q"], { cwd: process.env.UITALK_PROJECT });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: process.env.UITALK_PROJECT });
  execFileSync("git", ["config", "user.name", "t"], { cwd: process.env.UITALK_PROJECT });
  writeFileSync(join(process.env.UITALK_PROJECT, "a.css"), ".a{color:red}\n");
  execFileSync("git", ["add", "."], { cwd: process.env.UITALK_PROJECT });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: process.env.UITALK_PROJECT });

  // The snapshot and captureAfter are real git subprocess calls; how long they
  // take is the machine's business, so wait for the state rather than a duration.
  const until = async (cond, what) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const untilPhase = (phase) => until(() => bridge.approvalPhaseForTest() === phase, `approval phase "${phase}"`);

  {
    // adapter/opencode mode calls session.send() synchronously inside
    // pushToAgent(), with no await in between — so if the old fire-and-forget
    // snapshot code were still here, the agent would already have the edit
    // instruction the instant deliver() returns, well before the snapshot's
    // own subprocess call could possibly have resolved.
    const p = makePage();
    const sent = [];
    bridge.setSessionForTest({ mode: "adapter", send: (c) => sent.push(c) });
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "make it bold", ref: 1, declarations: "font-weight:700", element: {} });
    check("the agent is not pushed the edit instruction before the pre-edit snapshot exists",
      sent.length === 0, `pushed ${sent.length} time(s) synchronously`);

    await untilPhase("editing");
    check("...and receives it once the snapshot has actually been taken",
      sent.length === 1 && /Now commit this to source/.test(sent[0]), JSON.stringify(sent));
    check("the panel is told the change is revertable no earlier than that",
      p.sent.some((f) => f.kind === "revertable" && f.available === true), JSON.stringify(p.sent));

    bridge.setSessionForTest(null);
    await bridge.clearSession(); // drop lastChange and the approval phase before what follows
    p.close();
  }

  {
    // Two approvals close together: the second must be refused, deliberately
    // and visibly, rather than racing the first for lastChange.
    const p = makePage();
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "first", ref: 1, declarations: "color:red", element: {} });
    p.deliver({ kind: "approval", label: "second", ref: 2, declarations: "color:blue", element: {} });
    check("a second approval arriving before the first has finished is rejected, not raced",
      p.sent.some((f) => f.kind === "approval_rejected" && f.label === "second"),
      JSON.stringify(p.sent.map((f) => f.kind)));

    await untilPhase("editing");
    check("the first approval's own snapshot still completed undisturbed",
      p.sent.some((f) => f.kind === "revertable" && f.label === "first"),
      JSON.stringify(p.sent.filter((f) => f.kind === "revertable")));

    await bridge.clearSession();
    p.close();
  }

  {
    // A full approve -> edit -> approve -> edit -> undo sequence, run for real
    // (real git, real turn-end events), to prove undo lands on the most recent
    // approval rather than whichever snapshot happened to resolve last.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });

    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "first change", ref: 1, declarations: "color:red", element: {} });
    await untilPhase("editing"); // the pre-edit snapshot has resolved
    writeFileSync(join(proj, "a.css"), ".a{color:blue}\n"); // the "agent" makes the edit
    bridge.relay({ type: "result", subtype: "success" }); // its turn ends
    await untilPhase("idle"); // captureAfter has run

    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "second change", ref: 2, declarations: "color:green", element: {} });
    check("a second approval is accepted once the first one's turn has genuinely ended",
      !p.sent.some((f) => f.kind === "approval_rejected"), JSON.stringify(p.sent.map((f) => f.kind)));
    await untilPhase("editing");
    writeFileSync(join(proj, "a.css"), ".a{color:green}\n"); // the "agent" makes the second edit
    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the revert to answer");
    const reverted = p.sent.find((f) => f.kind === "reverted");
    check("undo after two sequential approvals names the most recent one",
      reverted?.ok === true && reverted.label === "second change", JSON.stringify(reverted));
    check("...and actually restores the file to its state from just before that edit",
      readFileSync(join(proj, "a.css"), "utf8") === ".a{color:blue}\n",
      readFileSync(join(proj, "a.css"), "utf8"));

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // An approval missing the fields it needs is refused rather than sent to
    // the agent as a nonsense edit instruction.
    const p = makePage();
    p.sent.length = 0;
    p.deliver({ kind: "approval" });
    check("an approval with no label or declarations is rejected rather than forwarded",
      p.sent.some((f) => f.kind === "approval_rejected"), JSON.stringify(p.sent.map((f) => f.kind)));
    p.close();
  }

  {
    // A revert also blocks a *new* approval, and a second revert, while it is
    // itself still rewriting the working tree — snapshot() and revertTo() must
    // never run concurrently against the same repo.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });

    p.deliver({ kind: "approval", label: "third change", ref: 1, declarations: "color:purple", element: {} });
    await untilPhase("editing");
    writeFileSync(join(proj, "a.css"), ".a{color:purple}\n");
    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    p.deliver({ kind: "approval", label: "fourth change", ref: 2, declarations: "color:black", element: {} });
    p.deliver({ kind: "revert" });
    check("a new approval arriving while a revert is in flight is rejected",
      p.sent.some((f) => f.kind === "approval_rejected" && f.label === "fourth change"),
      JSON.stringify(p.sent.map((f) => f.kind)));
    check("a second revert arriving while the first is in flight is rejected too",
      p.sent.filter((f) => f.kind === "reverted" && f.ok === false && /already undoing/.test(f.text ?? "")).length === 1,
      JSON.stringify(p.sent));

    await until(() => p.sent.some((f) => f.kind === "reverted" && f.ok === true), "the first revert to finish");
    check("the original revert still completes normally",
      p.sent.some((f) => f.kind === "reverted" && f.ok === true), JSON.stringify(p.sent));

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  // ------------------------------------------------- RPC answers are bound to
  // ------------------------------------------------- the socket asked, not id alone
  {
    const pageA = makePage();
    const pageB = makePage();
    pageA.deliver({ kind: "focus", url: "http://127.0.0.1:8400/a", visible: true });

    let settled = null;
    bridge.callPage("readSelection", {}, 500).then(
      (v) => (settled = { ok: true, v }),
      (e) => (settled = { ok: false, e: e.message }),
    );
    const rpc = pageA.sent.find((f) => f.kind === "rpc");
    check("the call is addressed to the active page", Boolean(rpc), JSON.stringify(pageA.sent.map((f) => f.kind)));

    pageB.deliver({ kind: "rpc_result", id: rpc.id, result: { selected: 999, hijacked: true } });
    await new Promise((r) => setTimeout(r, 30));
    check("a different connected page answering with the same request id does not settle it",
      settled === null, JSON.stringify(settled));

    pageA.deliver({ kind: "rpc_result", id: rpc.id, result: { selected: 3 } });
    await new Promise((r) => setTimeout(r, 30));
    check("the page the call actually went to can still answer it",
      settled?.ok === true && settled.v.selected === 3, JSON.stringify(settled));

    pageA.close();
    pageB.close();
  }

  // ------------------------------------------------------ active-page ownership
  {
    const a = makePage();
    const b = makePage();
    b.deliver({ kind: "focus", url: "http://127.0.0.1:8400/b", visible: true }); // b is now the active page

    a.sent.length = 0;
    b.sent.length = 0;
    a.deliver({ kind: "settings", patch: { compactAtPercent: 33 } }); // an ordinary frame from a background tab
    await new Promise((r) => setTimeout(r, 20));

    a.sent.length = 0;
    b.sent.length = 0;
    bridge.callPage("readSelection", {}, 300).catch(() => {});
    check("an ordinary frame from a background page does not steal active-page routing",
      b.sent.some((f) => f.kind === "rpc") && !a.sent.some((f) => f.kind === "rpc"),
      JSON.stringify({ aGotRpc: a.sent.some((f) => f.kind === "rpc"), bGotRpc: b.sent.some((f) => f.kind === "rpc") }));
    const firstRpc = b.sent.find((f) => f.kind === "rpc");
    if (firstRpc) b.deliver({ kind: "rpc_result", id: firstRpc.id, result: {} });

    a.sent.length = 0;
    b.sent.length = 0;
    a.deliver({ kind: "focus", url: "http://127.0.0.1:8400/a", visible: true }); // a explicitly takes focus
    bridge.callPage("readSelection", {}, 300).catch(() => {});
    check("an explicit focus frame does move active-page routing",
      a.sent.some((f) => f.kind === "rpc"), JSON.stringify(a.sent.map((f) => f.kind)));
    const secondRpc = a.sent.find((f) => f.kind === "rpc");
    if (secondRpc) a.deliver({ kind: "rpc_result", id: secondRpc.id, result: {} });

    a.close();
    b.close();
  }
}

// ------------------------------------------ the WebSocket upgrade trust boundary
//
// The bridge binds to loopback, which keeps other machines out, but a browser
// can still be made to open a WebSocket to a local port just by visiting a page
// that tries it. This exercises the real HTTP upgrade path end to end — a fake
// in-process socket cannot stand in for a real Origin header.
{
  const bridge = await import("../server/index.mjs");
  const { WebSocket } = await import("ws");

  await new Promise((resolve) => bridge.http.listen(0, "127.0.0.1", resolve));
  const port = bridge.http.address().port;

  const tryConnect = (origin) => new Promise((resolve) => {
    const opts = origin ? { headers: { Origin: origin } } : {};
    const sock = new WebSocket(`ws://127.0.0.1:${port}/__uitalk/socket`, opts);
    sock.on("open", () => {
      resolve({ ok: true });
      sock.close();
    });
    sock.on("unexpected-response", (req, res) => resolve({ ok: false, status: res.statusCode }));
    sock.on("error", () => resolve({ ok: false, status: null }));
  });

  const evil = await tryConnect("https://evil.example");
  check("a socket upgrade from an untrusted remote origin is refused",
    evil.ok === false && evil.status === 403, JSON.stringify(evil));

  const none = await tryConnect(null);
  check("a socket upgrade with no Origin header (MCP and other non-browser clients) is allowed",
    none.ok === true, JSON.stringify(none));

  const own = await tryConnect(`http://127.0.0.1:${port}`);
  check("a socket upgrade whose origin is the bridge's own address is allowed",
    own.ok === true, JSON.stringify(own));

  const bookmarklet = await tryConnect("http://localhost:5173");
  check("a socket upgrade from another loopback port (the bookmarklet's own dev server) is allowed",
    bookmarklet.ok === true, JSON.stringify(bookmarklet));

  await new Promise((resolve) => bridge.http.close(resolve));
}

// ------------------------------------- the client is served fresh, not from boot
{
  const bridge = await import("../server/index.mjs");
  const { readFileSync, writeFileSync, utimesSync } = await import("node:fs");
  const uiPath = new URL("../client/ui.js", import.meta.url).pathname;

  const first = bridge.readClient();
  check("the client is assembled with a build stamp", /__UITALK_BUILD__ = "[0-9a-f]{8}"/.test(first.body),
    first.build);
  check("reading it again without a change reuses what it had",
    bridge.readClient().build === first.build);

  // Touch the source the way an update would, and the bridge must notice without a
  // restart — otherwise a plugin update appears to do nothing.
  const original = readFileSync(uiPath, "utf8");
  try {
    writeFileSync(uiPath, `${original}\n// touched by the test\n`);
    const after = bridge.readClient();
    check("a changed client is picked up without restarting the bridge",
      after.build !== first.build, `${first.build} -> ${after.build}`);
    check("and the new stamp travels in the bundle",
      after.body.includes(`__UITALK_BUILD__ = "${after.build}"`));
  } finally {
    writeFileSync(uiPath, original);
  }

  const restored = bridge.readClient();
  check("restoring the file restores the stamp", restored.build === first.build,
    `${restored.build} vs ${first.build}`);

  check("checking the bridge's own freshness is harmless when nothing changed",
    bridge.checkServerFreshness() === undefined);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
