// The bridge's own logic: settings, the instance registry, git snapshots, the
// proxy's injection and diagnosis, the message the agent receives, and every page
// tool's handler. None of it needs a browser, an agent, or a listening socket —
// which is why it had no coverage until now.

process.env.UITALK_IMPORT_ONLY = "1"; // importing the bridge must not start one

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, statSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
  return ok; // so a test can gate dependent steps on a precondition it just asserted
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
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  let corrupt;
  try {
    corrupt = settings.load(project);
  } finally {
    console.warn = realWarn;
  }
  check("a corrupt project file falls back rather than throwing", corrupt.compactAtPercent === 11,
    String(corrupt.compactAtPercent));
  check("and the corrupt file is called out, not silently ignored",
    warnings.some((w) => /\.uitalk\.json/.test(w) && /not valid JSON/.test(w)), warnings.join(" | "));
  rmSync(join(project, ".uitalk.json"));
  // An absent file, by contrast, is the normal case and must stay silent.
  const quiet = [];
  const realWarn2 = console.warn;
  console.warn = (...a) => quiet.push(a.join(" "));
  try {
    settings.load(project);
  } finally {
    console.warn = realWarn2;
  }
  check("an absent config is silent, not warned about", quiet.length === 0, quiet.join(" | "));

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

  // Saving normalizes the file to recognized settings: an unknown or mistyped key a
  // hand-edit left behind is dropped, not persisted forever, and a recognized one is
  // kept. (load() already ignores unknown keys, so this only makes the file match.)
  {
    const dirty = mkdtempSync(join(sandbox, "settings-save-"));
    writeFileSync(join(dirty, ".uitalk.json"),
      JSON.stringify({ replayLimit: 42, mistypedd: true, "not a setting": "x" }));
    settings.save(dirty, { compactAtPercent: 30 });
    const onDisk = JSON.parse(readFileSync(join(dirty, ".uitalk.json"), "utf8"));
    check("save keeps the recognized existing setting and the new patch",
      onDisk.replayLimit === 42 && onDisk.compactAtPercent === 30, JSON.stringify(onDisk));
    check("and drops the unknown/mistyped keys instead of persisting them",
      !("mistypedd" in onDisk) && !("not a setting" in onDisk), JSON.stringify(onDisk));
  }

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

// ------------------------------------------------------ turn coordinator (FSM)
{
  const { TurnCoordinator } = await import("../server/turn-coordinator.mjs");
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  // The legal happy paths.
  const a = new TurnCoordinator();
  check("a fresh coordinator is idle", a.isIdle && a.phase === "idle");
  a.snapshotting();
  a.editing();
  check("idle -> snapshotting -> editing is legal", a.phase === "editing");
  a.settle();
  check("settling returns to idle", a.isIdle);
  a.reverting();
  check("idle -> reverting is legal", a.phase === "reverting");
  a.settle();
  check("and reverting settles back to idle", a.isIdle);

  // The illegal transitions must throw, not silently corrupt the phase.
  const b = new TurnCoordinator();
  check("editing without a snapshot is refused", threw(() => b.editing()) && b.phase === "idle");
  check("reverting during a snapshot is refused", (b.snapshotting(), threw(() => b.reverting())) && b.phase === "snapshotting");
  check("a second snapshot while one is in flight is refused", threw(() => b.snapshotting()));
  b.editing();
  check("reverting while editing is refused", threw(() => b.reverting()) && b.phase === "editing");
  b.settle();

  // clear() abandons whatever was in flight and resets the gated state.
  const c = new TurnCoordinator();
  c.snapshotting();
  c.lastChange = { snap: {}, label: "x" };
  c.pendingApprovals.push({});
  c.noteWrite("a.css");
  c.clear();
  check("clear() resets phase, lastChange, held approvals and writes",
    c.isIdle && c.lastChange === null && c.pendingApprovals.length === 0 && c.writes.paths.size === 0 && c.writes.complete);

  // Write attribution: scoped only when complete AND non-empty; otherwise full diff.
  const w = new TurnCoordinator();
  check("no writes -> full-diff fallback (null scope)", w.writeScope() === null);
  w.noteWrite("a.css");
  w.noteWrite("b.css");
  check("complete writes -> scoped to those paths",
    JSON.stringify(w.writeScope()?.sort()) === JSON.stringify(["a.css", "b.css"]));
  w.markWritesIncomplete();
  check("an opaque tool makes it incomplete -> full-diff fallback", w.writeScope() === null);
  w.snapshotting();
  check("snapshotting() resets the write set", w.writes.paths.size === 0 && w.writes.complete);
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
  check("removing the last entry leaves nothing behind", !existsSync(registry.registryPath),
    existsSync(registry.registryPath) ? readdirSync(registry.registryPath).join(", ") : "gone");
  check("listing an empty registry is empty, not an error", registry.list().length === 0);

  // A malformed instance file must be ignored (and pruned), not crash listing.
  registry.add({ pid: process.pid, port: 8402, appHost: "127.0.0.1", appPort: 5175, project: "/c" });
  writeFileSync(join(registry.registryPath, "garbage.json"), "{ not json");
  const listedWithGarbage = registry.list();
  check("a malformed instance file is ignored, not fatal",
    listedWithGarbage.some((e) => e.pid === process.pid) && listedWithGarbage.every((e) => e.pid !== undefined),
    JSON.stringify(listedWithGarbage.map((e) => e.pid)));
  check("and the malformed file is pruned", !existsSync(join(registry.registryPath, "garbage.json")));
  registry.remove(process.pid);
}

// ------------------------------------------- registry: concurrent registration
// The bug this design fixes is cross-process: a shared read-modify-write file
// lost an update when two bridges started at once. Prove it with real separate
// processes registering at the same time, each writing only its own entry.
{
  const registry = await import("../server/registry.mjs");
  const regUrl = new URL("../server/registry.mjs", import.meta.url).href;
  const N = 6;
  const basePort = 8600;

  // Each child registers under its own live pid, then stays alive on stdin so its
  // pid is still running when the parent inspects — list() prunes dead ones.
  const childSrc =
    `const port = Number(process.env.CHILD_PORT);` +
    `import(process.env.REG_URL).then((reg) => {` +
    `  reg.add({ pid: process.pid, port, appHost: "127.0.0.1", appPort: port, project: "/proj-" + port });` +
    `  process.stdout.write("ready " + process.pid + "\\n");` +
    `  process.stdin.resume();` +
    `  process.stdin.on("end", () => process.exit(0));` +
    `});`;

  const children = [];
  const readyPid = (child) =>
    new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        const m = /ready (\d+)/.exec(buf);
        if (m) resolve(Number(m[1]));
      });
    });

  for (let i = 0; i < N; i++) {
    const child = spawn(process.execPath, ["-e", childSrc], {
      env: { ...process.env, CHILD_PORT: String(basePort + i), REG_URL: regUrl },
      stdio: ["pipe", "pipe", "inherit"],
    });
    children.push(child);
  }
  const pids = await Promise.all(children.map(readyPid));

  const listed = registry.list();
  check("every one of N concurrent registrations survives (no lost update)",
    pids.every((pid) => listed.some((e) => e.pid === pid)) && new Set(pids).size === N,
    `${listed.filter((e) => pids.includes(e.pid)).length} of ${N} present`);

  // Removing one instance must not remove another.
  registry.remove(pids[0]);
  const afterRemove = registry.list();
  check("removing one instance leaves the others",
    !afterRemove.some((e) => e.pid === pids[0]) && pids.slice(1).every((pid) => afterRemove.some((e) => e.pid === pid)),
    JSON.stringify(afterRemove.map((e) => e.pid)));

  for (const pid of pids.slice(1)) registry.remove(pid);
  for (const child of children) child.stdin.end();
  await Promise.all(children.map((c) => new Promise((r) => c.on("exit", r))));
}

// -------------------------------------------- token: concurrent first requests
// A bridge and its MCP server can ask for the same project's token at the same
// instant; a shared JSON store let each generate a different one and the second
// write win, so the MCP client held a token the bridge never accepted. Prove
// separate processes converge on one token.
{
  const tokUrl = new URL("../server/token.mjs", import.meta.url).href;
  // Each child imports token.mjs, says "ready", then waits at a stdin barrier so
  // the parent can release them all at the same instant — process-boot jitter
  // otherwise spaces them out enough to hide the read-modify-write window.
  const tokChild =
    `import(process.env.TOK_URL).then((t) => {` +
    `  process.stdout.write("ready\\n");` +
    `  process.stdin.once("data", () => {` +
    `    process.stdout.write("TOKEN " + t.projectToken(process.env.PROJECT) + "\\n");` +
    `    process.exit(0);` +
    `  });` +
    `});`;
  const tokensFrom = (home, project, n) =>
    new Promise((resolve) => {
      const kids = [];
      const tokens = [];
      const ready = [];
      for (let i = 0; i < n; i++) {
        const c = spawn(process.execPath, ["-e", tokChild], {
          env: { ...process.env, UITALK_HOME: home, PROJECT: project, TOK_URL: tokUrl },
          stdio: ["pipe", "pipe", "inherit"],
        });
        let buf = "";
        c.stdout.on("data", (d) => {
          buf += d;
          if (/ready/.test(buf) && !c.__ready) {
            c.__ready = true;
            ready.push(c);
            if (ready.length === n) for (const k of ready) k.stdin.write("go\n"); // release together
          }
          const m = /TOKEN (\S+)/.exec(buf);
          if (m && !c.__tok) (c.__tok = true), tokens.push(m[1]);
        });
        kids.push(c);
      }
      Promise.all(kids.map((c) => new Promise((r) => c.on("exit", r)))).then(() => resolve(tokens));
    });
  const tokenFrom = (home, project) => tokensFrom(home, project, 1).then((a) => a[0]);

  const home = mkdtempSync(join(sandbox, "tok-home-"));
  const projA = mkdtempSync(join(sandbox, "tok-projA-"));
  const projB = mkdtempSync(join(sandbox, "tok-projB-"));

  // Several processes ask for projA's token at the same instant, before it exists.
  const tokens = await tokensFrom(home, projA, 8);
  check("every concurrent first request gets a non-empty token",
    tokens.length === 8 && tokens.every((t) => t.length > 0), JSON.stringify(tokens.map((t) => t.length)));
  check("and every process gets the identical token (no split-brain)",
    new Set(tokens).size === 1, `${new Set(tokens).size} distinct`);

  const later = await tokenFrom(home, projA);
  check("a later request returns the same token", later === tokens[0], `${later.slice(0, 8)} vs ${tokens[0].slice(0, 8)}`);

  const tokB = await tokenFrom(home, projB);
  check("a different project gets a different token", tokB !== tokens[0] && tokB.length > 0);
  check("the same project gets the same token again", (await tokenFrom(home, projA)) === tokens[0]);

  if (process.platform !== "win32") {
    const tokenFileName = readdirSync(join(home, "tokens")).find((f) => f.endsWith(".token"));
    const mode = statSync(join(home, "tokens", tokenFileName)).mode & 0o777;
    check("the token file is owner-only (0600)", mode === 0o600, mode.toString(8));
  }

  // Legacy migration: a token already in the old tokens.json is reused, not rotated.
  const legacyHome = mkdtempSync(join(sandbox, "tok-legacy-"));
  const legacyProj = mkdtempSync(join(sandbox, "tok-legacyproj-"));
  const legacyKey = realpathSync(legacyProj); // token.mjs keys by realpath on this platform
  const legacyValue = "legacy0000000000000000000000000000000000000000ab";
  mkdirSync(legacyHome, { recursive: true });
  writeFileSync(join(legacyHome, "tokens.json"), JSON.stringify({ [legacyKey]: legacyValue }) + "\n");
  const migrated = await tokenFrom(legacyHome, legacyProj);
  check("an existing legacy token is reused, not rotated", migrated === legacyValue, `${migrated.slice(0, 12)}…`);
  check("and it is now stored in the race-safe per-project file",
    (await tokenFrom(legacyHome, legacyProj)) === legacyValue);
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

  // The socket is token-gated, so a discovered URL carries this project's token.
  const { projectToken } = await import("../server/token.mjs");
  const urlFor = (port, project) => `ws://127.0.0.1:${port}/__uitalk/socket?token=${projectToken(project)}`;

  check("with one matching project, discovery finds its bridge (with its token)",
    bridgeUrl({ project: projA }) === urlFor(8500, projA), bridgeUrl({ project: projA }));
  check("with several registered, the exact project still wins",
    bridgeUrl({ project: projB }) === urlFor(8501, projB), bridgeUrl({ project: projB }));

  check("a trailing separator does not defeat the match",
    bridgeUrl({ project: projA + "/" }) === urlFor(8500, projA), bridgeUrl({ project: projA + "/" }));

  const linkToA = join(sandbox, "link-to-a");
  symlinkSync(projA, linkToA);
  check("a symlink to the project resolves to the same bridge and token",
    bridgeUrl({ project: linkToA }) === urlFor(8500, projA), bridgeUrl({ project: linkToA }));

  check("canonical normalizes a trailing separator away",
    canonical(projA + "/") === canonical(projA), `${canonical(projA + "/")} vs ${canonical(projA)}`);

  let noMatch = null;
  try { bridgeUrl({ project: join(sandbox, "not-registered") }); }
  catch (e) { noMatch = e.message; }
  check("no bridge for this project fails loudly instead of picking another",
    /no uitalk is running for/.test(noMatch ?? ""), noMatch);
  check("and the error names what is registered, to diagnose the mismatch",
    noMatch?.includes(projA) && noMatch?.includes(":8500"), noMatch);

  // The bridge rejects EVERY tokenless connection, so an explicit port to a bridge
  // not in the registry must still carry a token — derived from UITALK_PROJECT, which
  // authenticates when it matches the bridge's own project. A tokenless URL here
  // (the old behavior) could never connect.
  check("an explicit port to an unregistered bridge derives its token from the given project",
    bridgeUrl({ port: 9999, project: join(sandbox, "not-registered") }) === urlFor(9999, join(sandbox, "not-registered")),
    bridgeUrl({ port: 9999, project: join(sandbox, "not-registered") }));
  check("an explicit port to a registered bridge still carries that bridge's token",
    bridgeUrl({ port: 8500, project: join(sandbox, "irrelevant") }) === urlFor(8500, projA),
    bridgeUrl({ port: 8500 }));

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

// ------------------------------------- usage counting through path aliases
{
  const { countUsages } = await import("../server/usage.mjs");
  const mkFile = (p, rel, body) => { mkdirSync(dirname(join(p, rel)), { recursive: true }); writeFileSync(join(p, rel), body); };

  // tsconfig paths + baseUrl (JSONC, with a comment and a trailing comma): both an
  // aliased import and a bare baseUrl import resolve to the defining file.
  {
    const p = mkdtempSync(join(sandbox, "alias-ts-"));
    mkFile(p, "tsconfig.json", `{
      // project config
      "compilerOptions": {
        "baseUrl": "src",
        "paths": { "@/*": ["*"] },
      }
    }`);
    mkFile(p, "src/components/Button.tsx", "export function Button() { return <button/>; }\n");
    mkFile(p, "src/pages/Aliased.tsx", 'import { Button } from "@/components/Button";\nexport default () => <Button/>;\n');
    mkFile(p, "src/pages/Bare.tsx", 'import { Button } from "components/Button";\nexport default () => <Button/>;\n');
    const r = countUsages(p, "Button", "src/components/Button.tsx");
    check("a tsconfig path alias resolves to confirmed, not possible", r?.confirmedFiles === 2 && r?.possibleFiles === 0, JSON.stringify(r));
  }

  // jsconfig (no tsconfig) is read the same way.
  {
    const p = mkdtempSync(join(sandbox, "alias-js-"));
    mkFile(p, "jsconfig.json", '{ "compilerOptions": { "paths": { "@components/*": ["src/components/*"] } } }');
    mkFile(p, "src/components/Button.jsx", "export function Button() { return <button/>; }\n");
    mkFile(p, "src/pages/A.jsx", 'import { Button } from "@components/Button";\nexport default () => <Button/>;\n');
    const r = countUsages(p, "Button", "src/components/Button.jsx");
    check("a jsconfig path alias resolves to confirmed", r?.confirmedFiles === 1, JSON.stringify(r));
  }

  // Vite object alias: @ -> path.resolve(__dirname, "src"). An alias that isn't
  // declared anywhere (~) can't be confirmed and stays possible — not a false confirm.
  {
    const p = mkdtempSync(join(sandbox, "alias-vite-obj-"));
    mkFile(p, "vite.config.ts", 'import path from "node:path";\nexport default { resolve: { alias: { "@": path.resolve(__dirname, "src") } } };\n');
    mkFile(p, "src/components/Button.tsx", "export function Button() { return <button/>; }\n");
    mkFile(p, "src/pages/A.tsx", 'import { Button } from "@/components/Button";\nexport default () => <Button/>;\n');
    mkFile(p, "src/pages/Undeclared.tsx", 'import { Button } from "~/components/Button";\nexport default () => <Button/>;\n');
    const r = countUsages(p, "Button", "src/components/Button.tsx");
    check("a Vite object alias resolves to confirmed", r?.confirmedFiles === 1, JSON.stringify(r));
    check("an undeclared alias stays possible, never a false confirm", r?.possibleFiles === 1, JSON.stringify(r));
  }

  // Vite array alias with the ESM replacement form fileURLToPath(new URL("./src", ...)).
  {
    const p = mkdtempSync(join(sandbox, "alias-vite-arr-"));
    mkFile(p, "vite.config.js", 'import { fileURLToPath } from "node:url";\nexport default { resolve: { alias: [ { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) } ] } };\n');
    mkFile(p, "src/components/Button.tsx", "export function Button() { return <button/>; }\n");
    mkFile(p, "src/x/A.tsx", 'import Button from "@/components/Button";\nexport default () => <Button/>;\n');
    const r = countUsages(p, "Button", "src/components/Button.tsx");
    check("a Vite array alias ({ find, replacement }) resolves to confirmed", r?.confirmedFiles === 1, JSON.stringify(r));
  }
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

// ------------------------------------------------ opencode config auto-wiring
{
  const { ensureUitalkMcp } = await import("../server/opencode-config.mjs");
  const { parseJsonc } = await import("../server/jsonc.mjs");
  const read = (p, f) => readFileSync(join(p, f), "utf8");

  // The tolerant parser itself: a // or , inside a string must survive, a real
  // trailing comma must not break the parse.
  check("parseJsonc keeps a // inside a string and drops a trailing comma",
    JSON.stringify(parseJsonc('{ "url": "http://x//y", "a": 1, }')) === '{"url":"http://x//y","a":1}',
    JSON.stringify(parseJsonc('{ "url": "http://x//y", "a": 1, }')));
  check("parseJsonc strips /* block */ comments and a trailing comma before them",
    JSON.stringify(parseJsonc('{ /* lead */ "a": 1 /* mid */, "b": 2, /* tail */ }')) === '{"a":1,"b":2}',
    JSON.stringify(parseJsonc('{ /* lead */ "a": 1 /* mid */, "b": 2, /* tail */ }')));
  check("parseJsonc returns null on genuinely broken input", parseJsonc('{ "a": ') === null);

  // No config at all: one is created, valid, pointing at uitalk.
  {
    const proj = mkdtempSync(join(sandbox, "oc-none-"));
    const r = ensureUitalkMcp(proj);
    check("creates opencode.json when none exists", r.action === "created" && r.file === "opencode.json", JSON.stringify(r));
    const cfg = JSON.parse(read(proj, "opencode.json"));
    check("the created config points OpenCode at uitalk-mcp",
      cfg.mcp?.uitalk?.command?.[0] === "uitalk-mcp" && cfg.mcp.uitalk.environment.UITALK_PROJECT === proj,
      JSON.stringify(cfg.mcp));
    check("a second call is idempotent, not a duplicate write", ensureUitalkMcp(proj).action === "present");
  }

  // Existing JSONC with comments and another MCP server: uitalk is spliced in and
  // every comment survives, because the file is edited, not rewritten.
  {
    const proj = mkdtempSync(join(sandbox, "oc-jsonc-"));
    const original = `{
  // our project's OpenCode config
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "other": { "type": "local", "command": ["other-mcp"] } // keep this one
  },
  "model": "anthropic/claude", // trailing comma below is legal JSONC
}
`;
    writeFileSync(join(proj, "opencode.jsonc"), original);
    const r = ensureUitalkMcp(proj);
    check("splices into an existing opencode.jsonc", r.action === "inserted" && r.file === "opencode.jsonc", JSON.stringify(r));
    const after = read(proj, "opencode.jsonc");
    check("the hand-written comments are preserved verbatim",
      after.includes("// our project's OpenCode config") &&
        after.includes("// keep this one") &&
        after.includes("// trailing comma below is legal JSONC"),
      after);
    const cfg = parseJsonc(after);
    check("uitalk is now present alongside the existing server",
      cfg.mcp?.uitalk?.command?.[0] === "uitalk-mcp" && cfg.mcp?.other?.command?.[0] === "other-mcp",
      JSON.stringify(cfg.mcp));
    check("splicing is idempotent too", ensureUitalkMcp(proj).action === "present");
  }

  // Existing config with no mcp key at all: an mcp block is added at the root.
  {
    const proj = mkdtempSync(join(sandbox, "oc-nomcp-"));
    writeFileSync(join(proj, "opencode.json"), `{\n  "model": "anthropic/claude"\n}\n`);
    const r = ensureUitalkMcp(proj);
    check("adds an mcp block when the config has none", r.action === "inserted", JSON.stringify(r));
    const cfg = JSON.parse(read(proj, "opencode.json"));
    check("the existing keys are kept when mcp is added",
      cfg.model === "anthropic/claude" && cfg.mcp?.uitalk?.command?.[0] === "uitalk-mcp", JSON.stringify(cfg));
  }

  // A malformed config is left strictly alone rather than clobbered.
  {
    const proj = mkdtempSync(join(sandbox, "oc-bad-"));
    const broken = `{ "mcp": { "other": { `; // truncated, unparseable
    writeFileSync(join(proj, "opencode.json"), broken);
    const r = ensureUitalkMcp(proj);
    check("refuses to touch a config it cannot parse", r.action === "skipped", JSON.stringify(r));
    check("and leaves the broken file byte-for-byte unchanged", read(proj, "opencode.json") === broken);
  }
}

// --------------------------------------------------------------- snapshots
{
  // A backstop: if any snapshot/git step throws unexpectedly (a transient git
  // failure on CI, say), record it as one failure and let the rest of the suite
  // run, instead of letting an uncaught throw abort every later section.
  try {
  const snapshots = await import("../server/snapshots.mjs");
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });

  check("a directory that is not a repository says so", (await snapshots.isRepo(repo)) === false);
  check("and cannot be snapshotted", (await snapshots.snapshot(repo, "x")) === null);

  // When a git step fails on a tree that IS a repo, snapshot() still returns null
  // (undo unavailable) but must surface the reason through onError rather than
  // swallowing it — an intermittent failure has to be diagnosable. A freshly
  // init'd repo with no commit yet makes a git step fail deterministically.
  {
    const headless = join(sandbox, "headless-repo");
    mkdirSync(headless, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: headless });
    let captured = null;
    const snap = await snapshots.snapshot(headless, "before first commit", (err) => { captured = err; });
    check("snapshot() surfaces a git failure through onError instead of swallowing it",
      snap === null && captured instanceof Error, captured?.message?.split("\n")[0]);
  }

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

  // A pre-existing untracked file the agent DELETES must come back on undo — its
  // bytes were blobbed at snapshot time even though it no longer exists after.
  {
    writeFileSync(join(repo, "Draft3.css"), ".d { color: red } /* user's own */\n");
    const snap0 = await snapshots.snapshot(repo, "agent deletes an untracked file");
    unlinkSync(join(repo, "Draft3.css")); // the "agent" deletes it
    const snap = await snapshots.captureAfter(repo, snap0);
    check("a deleted pre-existing untracked file is seen as the agent's to restore",
      snap.deletedUntracked?.includes("Draft3.css"), JSON.stringify(snap.deletedUntracked));

    const out = await snapshots.revertTo(repo, snap);
    check("undo restores a deleted pre-existing untracked file",
      out.reverted.includes("Draft3.css") && existsSync(join(repo, "Draft3.css")), JSON.stringify(out));
    check("and its exact pre-deletion contents come back",
      readFileSync(join(repo, "Draft3.css"), "utf8") === ".d { color: red } /* user's own */\n",
      readFileSync(join(repo, "Draft3.css"), "utf8").trim());
    unlinkSync(join(repo, "Draft3.css"));
  }

  // The same, but the user recreates that path after the agent's turn: undo must
  // not clobber what they put back.
  {
    writeFileSync(join(repo, "Draft4.css"), ".d { color: red }\n");
    const snap0 = await snapshots.snapshot(repo, "agent deletes, user recreates");
    unlinkSync(join(repo, "Draft4.css")); // the "agent" deletes it
    const snap = await snapshots.captureAfter(repo, snap0);
    writeFileSync(join(repo, "Draft4.css"), ".d { color: green } /* user put it back */\n");

    const out = await snapshots.revertTo(repo, snap);
    check("a deleted file the user recreated is skipped, not clobbered",
      out.skipped.includes("Draft4.css") && !out.reverted.includes("Draft4.css"), JSON.stringify(out));
    check("the user's recreated file survives untouched",
      readFileSync(join(repo, "Draft4.css"), "utf8").includes("user put it back"));
    unlinkSync(join(repo, "Draft4.css"));
  }

  // git octal-quotes a non-ASCII path by default ("caf\303\251.css"); left quoted
  // it reaches hash-object/checkout as a bogus pathspec, so an accented filename
  // was silently un-undoable. Both a tracked and a pre-existing untracked one.
  {
    writeFileSync(join(repo, "café.css"), ".c { color: red }\n");
    git("add", ".");
    git("commit", "-qm", "accented baseline");
    const snap0 = await snapshots.snapshot(repo, "restyle an accented tracked file");
    // snapshot() is documented to return null when it can't snapshot; honour that
    // contract rather than dereferencing it, so a transient git failure surfaces
    // as one legible failure instead of an uncaught throw that aborts the suite.
    if (check("a tracked non-ASCII file can be snapshotted", !!snap0, "snapshot() returned null")) {
      writeFileSync(join(repo, "café.css"), ".c { color: blue }\n");
      const snap = await snapshots.captureAfter(repo, snap0);
      check("a tracked non-ASCII filename is seen as changed by the agent",
        snap.changedByAgent.includes("café.css"), JSON.stringify(snap.changedByAgent));
      const out = await snapshots.revertTo(repo, snap);
      check("undo restores a tracked non-ASCII file",
        out.reverted.includes("café.css") && readFileSync(join(repo, "café.css"), "utf8").includes("red"),
        JSON.stringify(out.reverted));
    }
  }

  {
    writeFileSync(join(repo, "résumé.css"), ".r { color: red } /* user's own */\n");
    const snap0 = await snapshots.snapshot(repo, "restyle a pre-existing untracked accented file");
    if (check("a pre-existing untracked non-ASCII file can be snapshotted", !!snap0, "snapshot() returned null")) {
      writeFileSync(join(repo, "résumé.css"), ".r { color: blue } /* agent */\n");
      const snap = await snapshots.captureAfter(repo, snap0);
      const out = await snapshots.revertTo(repo, snap);
      check("undo restores a pre-existing untracked non-ASCII file to its exact contents",
        out.reverted.includes("résumé.css") &&
          readFileSync(join(repo, "résumé.css"), "utf8") === ".r { color: red } /* user's own */\n",
        JSON.stringify(out));
    }
    if (existsSync(join(repo, "résumé.css"))) unlinkSync(join(repo, "résumé.css"));
  }

  // Undo restores the worktree but must NOT touch the index — a `git checkout
  // <ref> -- <path>` would rewrite staging too. These assert the index explicitly.
  const staged = (file) => git("show", `:${file}`).toString(); // the index version of a path
  const porcelain = () => git("status", "--porcelain=v1").toString().trim();

  {
    // Staged B, unstaged worktree C, agent -> D, undo. Worktree must come back to
    // C while the index keeps B — the two versions must not collapse into one.
    writeFileSync(join(repo, "split.css"), "A\n");
    git("add", "split.css");
    git("commit", "-qm", "split A");
    writeFileSync(join(repo, "split.css"), "B\n");
    git("add", "split.css"); // index = B
    writeFileSync(join(repo, "split.css"), "C\n"); // worktree = C
    const indexBefore = staged("split.css");
    const statusBefore = porcelain();

    const snap0 = await snapshots.snapshot(repo, "restyle a staged+unstaged file");
    writeFileSync(join(repo, "split.css"), "D\n"); // agent
    const snap = await snapshots.captureAfter(repo, snap0);
    const out = await snapshots.revertTo(repo, snap);

    check("undo restores the unstaged worktree version", readFileSync(join(repo, "split.css"), "utf8") === "C\n",
      readFileSync(join(repo, "split.css"), "utf8").trim());
    check("and leaves the staged version untouched (index not collapsed)",
      staged("split.css") === indexBefore && indexBefore.trim() === "B", `index=${staged("split.css").trim()}`);
    check("and the staged/unstaged split survives undo byte-for-byte",
      porcelain() === statusBefore, `${porcelain()} vs ${statusBefore}`);
    check("undo reported the file as reverted", out.reverted.includes("split.css"), JSON.stringify(out));
  }

  {
    // A pre-existing UNSTAGED edit (index A, worktree B), agent -> C, undo. The
    // file must return to B and stay unstaged — undo must not stage it.
    writeFileSync(join(repo, "unstaged.css"), "A\n");
    git("add", "unstaged.css");
    git("commit", "-qm", "unstaged A");
    writeFileSync(join(repo, "unstaged.css"), "B\n"); // unstaged edit
    const statusBefore = porcelain();

    const snap0 = await snapshots.snapshot(repo, "restyle an unstaged file");
    writeFileSync(join(repo, "unstaged.css"), "C\n"); // agent
    const snap = await snapshots.captureAfter(repo, snap0);
    await snapshots.revertTo(repo, snap);

    check("undo restores the pre-agent unstaged content", readFileSync(join(repo, "unstaged.css"), "utf8") === "B\n",
      readFileSync(join(repo, "unstaged.css"), "utf8").trim());
    check("and the file stays unstaged, not turned into a staged change",
      /^ M unstaged\.css$/m.test(porcelain()) && porcelain() === statusBefore, porcelain());
  }

  {
    // A clean committed file, agent -> B, undo -> A, with the index left clean.
    writeFileSync(join(repo, "clean.css"), "A\n");
    git("add", "clean.css");
    git("commit", "-qm", "clean A");
    const snap0 = await snapshots.snapshot(repo, "restyle a clean file");
    writeFileSync(join(repo, "clean.css"), "B\n");
    const snap = await snapshots.captureAfter(repo, snap0);
    await snapshots.revertTo(repo, snap);

    check("undo restores a clean tracked file", readFileSync(join(repo, "clean.css"), "utf8") === "A\n",
      readFileSync(join(repo, "clean.css"), "utf8").trim());
    check("and leaves nothing staged for it",
      !/clean\.css/.test(porcelain()), porcelain() || "clean");
  }

  {
    // The !postCaptured fallback (undo pressed before the turn ended) must keep the
    // same index invariant. Stage B, edit worktree to C, agent -> D, revert with no
    // captureAfter: worktree back to C, staged B untouched.
    writeFileSync(join(repo, "fallback.css"), "A\n");
    git("add", "fallback.css");
    git("commit", "-qm", "fallback A");
    writeFileSync(join(repo, "fallback.css"), "B\n");
    git("add", "fallback.css"); // index = B
    writeFileSync(join(repo, "fallback.css"), "C\n"); // worktree = C
    const snap0 = await snapshots.snapshot(repo, "fallback split");
    writeFileSync(join(repo, "fallback.css"), "D\n"); // agent, turn not yet ended
    const out = await snapshots.revertTo(repo, snap0); // no captureAfter → fallback branch

    check("the pre-capture fallback restores the worktree", readFileSync(join(repo, "fallback.css"), "utf8") === "C\n",
      readFileSync(join(repo, "fallback.css"), "utf8").trim());
    check("and the fallback leaves the index untouched too",
      staged("fallback.css").trim() === "B" && out.reverted.includes("fallback.css"),
      `index=${staged("fallback.css").trim()}`);
  }

  {
    // Precise scope: when the caller knows which files the agent wrote, undo must
    // touch only those — a file the user edited concurrently during the turn also
    // differs from the snapshot, but the agent never wrote it, so it stays.
    writeFileSync(join(repo, "agent.css"), "a: 1\n");
    writeFileSync(join(repo, "mine.css"), "m: 1\n");
    git("add", ".");
    git("commit", "-qm", "scope baseline");
    const snap0 = await snapshots.snapshot(repo, "scoped edit");
    writeFileSync(join(repo, "agent.css"), "a: 2\n"); // the agent's edit
    writeFileSync(join(repo, "mine.css"), "m: 2\n"); // the user, editing concurrently

    const snap = await snapshots.captureAfter(repo, snap0, ["agent.css"]); // only the agent's write is known
    check("captureAfter scopes to the files the agent actually wrote",
      snap.changedByAgent.includes("agent.css") && !snap.changedByAgent.includes("mine.css"),
      JSON.stringify(snap.changedByAgent));

    const out = await snapshots.revertTo(repo, snap);
    check("undo reverts the agent's file", out.reverted.includes("agent.css") &&
      readFileSync(join(repo, "agent.css"), "utf8") === "a: 1\n", JSON.stringify(out.reverted));
    check("and leaves the file the user edited concurrently untouched",
      !out.reverted.includes("mine.css") && readFileSync(join(repo, "mine.css"), "utf8") === "m: 2\n",
      readFileSync(join(repo, "mine.css"), "utf8").trim());

    // No write info (an MCP client, or an unseen tool) falls back to the full diff.
    const snap1 = await snapshots.snapshot(repo, "unscoped");
    writeFileSync(join(repo, "agent.css"), "a: 3\n");
    writeFileSync(join(repo, "mine.css"), "m: 3\n");
    const snapAll = await snapshots.captureAfter(repo, snap1, []);
    check("with no write info, capture falls back to the whole diff",
      snapAll.changedByAgent.includes("agent.css") && snapAll.changedByAgent.includes("mine.css"),
      JSON.stringify(snapAll.changedByAgent));
    git("checkout", "--", "agent.css", "mine.css");
  }
  } catch (err) {
    check("the snapshots section ran without an unexpected throw", false, err.stack || String(err));
  }
}

// ------------------------------------------------------------------- proxy
{
  const { createProxy, proxyUpgrade } = await import("../server/proxy.mjs");

  // A streaming SSR response: the head is flushed at once, the body is held until
  // the test opens the gate. It lets the test prove the tag is injected and sent
  // before the body streams, rather than the whole page being buffered first.
  let openGate;
  const gate = new Promise((r) => (openGate = r));

  const app = createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head><title>s</title></head><body>");
      gate.then(() => {
        res.write("STREAMED-BODY");
        res.end("</body></html>");
      });
      return;
    }
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
    if (req.url === "/api.json") {
      // A non-HTML response with its own CSP: nothing is injected into it, so its
      // policy must survive the proxy untouched.
      res.writeHead(200, { "content-type": "application/json", "content-security-policy": "default-src 'none'" });
      return res.end('{"ok":true}');
    }
    if (req.url === "/mentions-uitalk") {
      // A page that merely mentions the string data-uitalk (docs, an example, an
      // unrelated attribute) must still get the client injected.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<html><head><title>d</title></head><body><code>data-uitalk-demo</code></body></html>');
    }
    if (req.url === "/already-injected") {
      // A page that already carries the uitalk client (a re-proxied page) must not
      // get a second copy.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<html><head><script src="/__uitalk/client.js" data-uitalk></script></head><body>x</body></html>');
    }
    if (req.url === "/asset-drop") {
      // Promise 100 bytes, send 7, then abruptly drop the socket — as a dev server
      // does when it restarts mid-response. The unfulfilled content-length makes
      // the proxy's upstream response stream emit 'error' (ECONNRESET).
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.socket.destroy(), 20);
      return;
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
  const served = new Map();
  const proxy = createServer(createProxy({ target, onInject: (u) => injected.push(u), onHtml: (u, h) => served.set(u, h) }));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const at = (path) => `http://127.0.0.1:${proxy.address().port}${path}`;

  const home = await fetch(at("/"));
  const html = await home.text();
  check("the client is injected into html", html.includes('src="/__uitalk/client.js"'));
  check("it goes before </head> when there is one", html.indexOf("__uitalk/client.js") < html.indexOf("</head>"));
  check("a strict CSP is stripped from what we rewrite", !home.headers.get("content-security-policy"),
    home.headers.get("content-security-policy") ?? "removed");
  // The body is rewritten as it streams, so its length is unknown up front: it
  // goes out chunked with no (stale) content-length, and the received bytes are
  // still the whole injected document.
  check("a rewritten document carries no stale content-length", home.headers.get("content-length") === null,
    home.headers.get("content-length") ?? "none");
  check("the streamed body is the complete injected document",
    html === '<html><head><title>t</title>' + '<script src="/__uitalk/client.js" data-uitalk></script>' + '</head><body>hi</body></html>',
    html);
  check("the injection is reported", injected.includes("/"));

  check("a page with no head is still injected", (await (await fetch(at("/nohead"))).text()).includes("__uitalk/client.js"));
  check("even a bare fragment is injected", (await (await fetch(at("/fragment"))).text()).includes("__uitalk/client.js"));

  check("the served html is captured for locate_source", (served.get("/") ?? "").includes("<title>t"),
    (served.get("/") ?? "").slice(0, 40));

  // Streaming: the head (with the tag) reaches the client before the body is even
  // sent upstream — proof the response is not buffered whole before the first byte.
  {
    const r = await fetch(at("/stream"));
    check("a streamed document is chunked, not given a content-length",
      r.headers.get("content-length") === null, r.headers.get("content-length") ?? "none");
    const reader = r.body.getReader();
    const first = Buffer.from((await reader.read()).value).toString("utf8");
    check("the injected head is flushed before the gated body streams",
      /__uitalk\/client\.js/.test(first) && first.indexOf("__uitalk/client.js") < first.indexOf("</head>") && !first.includes("STREAMED-BODY"),
      first);
    openGate(); // now let upstream send the rest
    let rest = first;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += Buffer.from(value).toString("utf8");
    }
    check("the rest of the body streams through intact after injection",
      rest.includes("STREAMED-BODY") && rest.endsWith("</body></html>") &&
        rest.match(/__uitalk\/client\.js/g).length === 1,
      rest.slice(-60));
  }

  const asset = await fetch(at("/asset.js"));
  check("non-html passes through untouched", (await asset.text()) === "console.log(1)");
  check("and an asset keeps its validator, so reloads stay cheap",
    asset.headers.get("etag") === 'W/"asset-1"', asset.headers.get("etag") ?? "stripped");

  // A non-HTML response keeps its own CSP — stripping is only for the HTML we inject
  // into. (Stripping it here would needlessly weaken an API/asset response.)
  const api = await fetch(at("/api.json"));
  check("a non-HTML response keeps its Content-Security-Policy",
    api.headers.get("content-security-policy") === "default-src 'none'",
    api.headers.get("content-security-policy") ?? "stripped");

  // Injection detection uses the exact client src, not the bare "data-uitalk" text,
  // so a page that merely mentions it is still injected...
  const mentions = await fetch(at("/mentions-uitalk"));
  const mentionsHtml = await mentions.text();
  check("a page that merely mentions data-uitalk is still injected",
    mentionsHtml.includes('src="/__uitalk/client.js"') && mentionsHtml.includes("data-uitalk-demo"),
    mentionsHtml.slice(0, 80));
  // ...while a page that already carries the client is not injected twice.
  const already = await (await fetch(at("/already-injected"))).text();
  check("a page already carrying the client is not injected twice",
    (already.match(/__uitalk\/client\.js/g) ?? []).length === 1,
    `${(already.match(/__uitalk\/client\.js/g) ?? []).length} client tags`);

  // An upstream that drops the connection mid-asset makes the proxy's upstream
  // response stream emit 'error'. With no handler that was an uncaught exception
  // that killed the whole bridge (every open page and agent with it). The client
  // just sees a dropped response; the proxy must stay up.
  try {
    // Time-boxed: without the fix the proxy never tears the client response down,
    // so this would hang — fail fast instead of stalling the whole suite.
    const r = await fetch(at("/asset-drop"), { signal: AbortSignal.timeout(3000) });
    await r.arrayBuffer();
  } catch {
    // a dropped connection (or the abort above) surfaces as a fetch error — expected
  }
  const afterDrop = await fetch(at("/asset.js"), { signal: AbortSignal.timeout(3000) });
  check("an upstream drop mid-asset does not crash the proxy",
    (await afterDrop.text()) === "console.log(1)");

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

// ---------------------------------------- per-project launcher files never collide
{
  const { projectSlug } = await import("../server/project-id.mjs");

  // Two unrelated repos that share a leaf directory name (…/company-a/frontend and
  // …/company-b/frontend) used to derive the same pidfile and log from the bare
  // basename — so one project's --stop read the other's pidfile and could kill its
  // dev server. Identity is now the canonical path, not just its leaf.
  const a = "/home/alice/company-a/frontend";
  const b = "/home/alice/company-b/frontend";
  const slugA = projectSlug(a);
  const slugB = projectSlug(b);

  check("two projects with the same basename get different slugs", slugA !== slugB,
    `${slugA} vs ${slugB}`);
  check("so their dev pidfiles differ", `${slugA}-dev.pid` !== `${slugB}-dev.pid`);
  check("and their dev logs differ", `${slugA}-dev.log` !== `${slugB}-dev.log`);
  check("so stopping project B can never target project A's dev pidfile",
    `${slugB}-dev.pid` !== `${slugA}-dev.pid`);

  check("the slug is stable for the same canonical path", projectSlug(a) === slugA);
  check("and is a single, filesystem-safe path segment",
    /^[A-Za-z0-9._-]+$/.test(slugA), slugA);

  // Anchor the guarantee to the launcher itself: its per-project files must be
  // keyed by projectSlug(project), not the bare basename that collided.
  const launcher = readFileSync(new URL("../bin/uitalk", import.meta.url), "utf8");
  check("the launcher keys its per-project files by projectSlug, not basename",
    /projectSlug\(project\)/.test(launcher) && !/basename\(project\)/.test(launcher));
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

  // A long session with no compaction must not grow the dedup set without bound.
  for (let i = 0; i < 2000; i++) {
    bridge.noteUsage({ type: "assistant", message: { id: `seen-${i}`, usage: { input_tokens: 1 } } });
  }
  check("the usage-dedup set is bounded, not grown for the whole session",
    bridge.context.seen.size <= 512, `seen=${bridge.context.seen.size}`);
  bridge.resetContextMeter();
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

  // Malformed show_options / ask_choice must be rejected at the tool boundary with
  // a useful message, and the page must never be asked (no half-mounted preview).
  answer = { ok: true };
  const opt = (n) => Array.from({ length: n }, (_, i) => ({ label: "o" + i, declarations: "color: red" }));
  const before = () => calls.length;
  const rejects = async (name, args, re) => {
    const at = before();
    const res = await run(name, args);
    return res.isError === true && re.test(res.content[0].text) && calls.length === at; // page untouched
  };
  const accepts = async (name, args) => {
    const at = before();
    const res = await run(name, args);
    return res.isError !== true && calls.length === at + 1; // reached the page
  };

  check("show_options with zero options is rejected cleanly",
    await rejects("show_options", { options: [] }, /between 2 and 10/));
  check("show_options with one option is rejected cleanly",
    await rejects("show_options", { options: opt(1) }, /between 2 and 10/));
  check("show_options with a non-array options is rejected cleanly",
    await rejects("show_options", { options: "nope" }, /between 2 and 10/));
  check("show_options with 2 options is accepted", await accepts("show_options", { options: opt(2) }));
  check("show_options with 10 options is accepted", await accepts("show_options", { options: opt(10) }));
  check("show_options with 11 options is rejected cleanly",
    await rejects("show_options", { options: opt(11) }, /between 2 and 10/));
  check("show_options with an empty label is rejected cleanly",
    await rejects("show_options", { options: [{ label: "", declarations: "x" }, { label: "b", declarations: "y" }] }, /label/));
  check("show_options with missing declarations is rejected cleanly",
    await rejects("show_options", { options: [{ label: "a" }, { label: "b", declarations: "y" }] }, /declarations/));

  check("ask_choice with one option is rejected cleanly",
    await rejects("ask_choice", { question: "Which?", options: ["only"] }, /between 2 and 6/));
  check("ask_choice with 2 options is accepted", await accepts("ask_choice", { question: "Which?", options: ["a", "b"] }));
  check("ask_choice with 6 options is accepted",
    await accepts("ask_choice", { question: "Which?", options: ["a", "b", "c", "d", "e", "f"] }));
  check("ask_choice with 7 options is rejected cleanly",
    await rejects("ask_choice", { question: "Which?", options: ["a", "b", "c", "d", "e", "f", "g"] }, /between 2 and 6/));
  check("ask_choice with a non-string question is rejected cleanly",
    await rejects("ask_choice", { question: 5, options: ["a", "b"] }, /needs a question/));
  check("ask_choice with an empty option string is rejected cleanly",
    await rejects("ask_choice", { question: "Which?", options: ["a", ""] }, /non-empty string/));

  // The JSON Schema must carry the same contract the prose promises.
  const { toolDefinitions } = await import("../server/tool-defs.mjs");
  const defs = Object.fromEntries(toolDefinitions(async () => ({})).map((d) => [d.name, d]));
  check("show_options schema declares minItems/maxItems",
    defs.show_options.schema.options.minItems === 2 && defs.show_options.schema.options.maxItems === 10);
  check("ask_choice schema declares minItems/maxItems",
    defs.ask_choice.schema.options.minItems === 2 && defs.ask_choice.schema.options.maxItems === 6);
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
    await cleared.catch(() => {}); // let the concurrent New Session fully finish before the next block
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
  // The ceiling is a stuck-test backstop, not a deadline — generous enough that a
  // loaded CI runner spawning git doesn't fail a passing test (10ms x 1500 = 15s).
  const until = async (cond, what) => {
    for (let i = 0; i < 1500; i++) {
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
    // The approval-mid-turn race: approving while a CHAT turn is still streaming
    // must NOT snapshot against that turn — its end would run the post-edit capture
    // before the approved edit is even made, finalizing an empty snapshot so undo
    // silently does nothing. The approval is held until the turn ends, then run as
    // its own edit turn, so undo restores exactly the approved change.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    writeFileSync(join(proj, "race.css"), ".r{color:red}\n"); // a fresh file, so the baseline always commits
    execFileSync("git", ["add", "race.css"], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "race baseline"], { cwd: proj });

    bridge.pushToAgent("what does this element do?"); // an ordinary chat turn is now streaming
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "make it green", ref: 1, declarations: "color:green", element: {} });
    await new Promise((r) => setTimeout(r, 30));
    check("an approval during a chat turn is held, not snapshotted against it",
      bridge.approvalPhaseForTest() === "idle" && !p.sent.some((f) => f.kind === "revertable"),
      `phase=${bridge.approvalPhaseForTest()} frames=${JSON.stringify(p.sent.map((f) => f.kind))}`);

    bridge.relay({ type: "result", subtype: "success" }); // the chat turn ends
    await untilPhase("editing"); // only now does the held approval snapshot + push its edit
    check("once the chat turn ends the held approval becomes revertable",
      p.sent.some((f) => f.kind === "revertable" && f.available === true),
      JSON.stringify(p.sent.map((f) => f.kind)));
    writeFileSync(join(proj, "race.css"), ".r{color:green}\n"); // the "agent" makes the approved edit
    bridge.relay({ type: "result", subtype: "success" }); // the edit turn ends → captureAfter
    await untilPhase("idle");

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the revert to answer");
    const rev = p.sent.find((f) => f.kind === "reverted");
    check("undo restores a change approved during a chat turn — the snapshot lined up with the edit",
      rev?.ok === true && readFileSync(join(proj, "race.css"), "utf8") === ".r{color:red}\n",
      JSON.stringify({ rev, now: readFileSync(join(proj, "race.css"), "utf8").trim() }));

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // A held approval must still run if the revert it waited behind FAILS. The
    // successful-revert path starts a turn (its notice to the agent) whose end
    // drains the queue; a failed revert starts no turn, so without an explicit
    // drain the held approval is stranded (and later fires on some unrelated turn).
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    writeFileSync(join(proj, "revfail.css"), ".x{color:red}\n");
    const hash = createHash("sha256").update(readFileSync(join(proj, "revfail.css"))).digest("hex");
    // "Already captured", but with a ref git cannot resolve and a matching changed
    // file — so revertTo() reaches its git restore and throws.
    const badSnap = () => ({
      ref: "uitalk-unresolvable-ref", label: "x", at: Date.now(), postCaptured: true,
      changedByAgent: ["revfail.css"], postHashes: { "revfail.css": hash },
      createdByAgent: [], createdHashes: {}, modifiedUntracked: [], untrackedBlobs: {},
    });
    bridge.setSnapshotForTest(badSnap);
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });

    // A committed, revertable change.
    p.deliver({ kind: "approval", label: "committed", ref: 1, declarations: "color:red", element: {} });
    await untilPhase("editing");
    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");

    // A chat turn is streaming; an approval arrives and is held.
    bridge.pushToAgent("meanwhile, a question");
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "held", ref: 2, declarations: "color:blue", element: {} });
    await new Promise((r) => setTimeout(r, 20));
    // Undo the committed change while the chat turn is still open, so the revert is
    // in flight ("reverting") when that turn ends — the point the inline drain skips.
    p.deliver({ kind: "revert" });
    bridge.relay({ type: "result", subtype: "success" });

    let ran = false;
    for (let i = 0; i < 200 && !ran; i++) {
      ran = p.sent.some((f) => f.kind === "revertable" && f.label === "held");
      if (!ran) await new Promise((r) => setTimeout(r, 10));
    }
    check("a held approval is not stranded when the revert it waited behind fails", ran,
      JSON.stringify(p.sent.map((f) => `${f.kind}:${f.label ?? ""}`)));

    bridge.setSnapshotForTest(null);
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
    // An ask_choice answer is a plain reply: it must not go through the CSS-approval
    // path (no snapshot, no revertable), or a tapped answer would look like an edit
    // the user could "undo".
    const p = makePage();
    p.sent.length = 0;
    bridge.transcript.length = 0;
    p.deliver({ kind: "choice_answer", label: "Use flexbox" });
    await new Promise((r) => setTimeout(r, 30));
    check("a choice_answer is recorded as a plain user reply",
      bridge.transcript.some((t) => t.role === "me" && t.text === "Use flexbox"), JSON.stringify(bridge.transcript));
    check("and is not routed through the CSS-approval path",
      bridge.approvalPhaseForTest() === "idle" && !p.sent.some((f) => f.kind === "revertable"),
      `phase=${bridge.approvalPhaseForTest()} frames=${JSON.stringify(p.sent.map((f) => f.kind))}`);
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

  {
    // A revert clicked while a NEW approval's snapshot is still being taken must be
    // refused, not run concurrently with that snapshot and then clobber lastChange
    // the moment it resolves. Force the snapshot to be slow so the window is real.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });

    // A prior, fully-captured change that undo could legitimately restore.
    writeFileSync(join(proj, "race.css"), ".r{color:red}\n");
    execFileSync("git", ["add", "."], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "prior baseline"], { cwd: proj });
    p.deliver({ kind: "approval", label: "prior change", ref: 1, declarations: "color:red", element: {} });
    await untilPhase("editing");
    writeFileSync(join(proj, "race.css"), ".r{color:blue}\n");
    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");

    // The next approval's snapshot hangs until we release it — the "snapshotting" window.
    let releaseSnap;
    bridge.setSnapshotForTest(
      (label) => new Promise((r) => { releaseSnap = () => r({ ref: "HEAD", label, at: Date.now() }); }),
    );
    p.deliver({ kind: "approval", label: "next change", ref: 2, declarations: "color:green", element: {} });
    await untilPhase("snapshotting");

    p.sent.length = 0;
    p.deliver({ kind: "revert" }); // clicked mid-snapshot
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the mid-snapshot revert to answer");
    check("a revert during an approval's snapshot window is refused, not run concurrently",
      p.sent.find((f) => f.kind === "reverted")?.ok === false,
      JSON.stringify(p.sent.find((f) => f.kind === "reverted")));
    check("and the prior change is left intact (its revert did not run)",
      readFileSync(join(proj, "race.css"), "utf8") === ".r{color:blue}\n",
      readFileSync(join(proj, "race.css"), "utf8").trim());

    releaseSnap();
    await untilPhase("editing"); // the approval completes normally once its snapshot resolves

    bridge.setSnapshotForTest(null);
    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // A finished turn must return the phase to idle even when the project is not a
    // git repo (snapshot() returns null) — otherwise the reset was skipped and the
    // phase latched at "editing", refusing every later approval.
    const p = makePage();
    bridge.setSnapshotForTest(() => null); // simulate a non-repo project
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    p.deliver({ kind: "approval", label: "no-repo change", ref: 1, declarations: "color:red", element: {} });
    await until(() => bridge.approvalPhaseForTest() === "editing", "phase editing after a non-repo approval");
    bridge.relay({ type: "result", subtype: "success" });
    await until(() => bridge.approvalPhaseForTest() === "idle", "phase idle after the turn ends");
    check("a finished turn frees the phase even with no snapshot to freeze",
      bridge.approvalPhaseForTest() === "idle", bridge.approvalPhaseForTest());

    bridge.setSnapshotForTest(null);
    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // If the post-edit capture throws (a transient git failure at turn-end), the
    // phase must STILL return to idle — otherwise a single hiccup wedges every
    // later approval and revert off until a session clear. Force it: hand the
    // approval a snapshot whose ref git can't resolve, so captureAfter() throws
    // when the turn ends.
    const p = makePage();
    bridge.setSnapshotForTest((label) => ({
      ref: "uitalk-not-a-real-ref", label, at: Date.now(), untrackedBefore: [], untrackedBlobs: {},
    }));
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    p.deliver({ kind: "approval", label: "edit with a doomed capture", ref: 1, declarations: "color:red", element: {} });
    await until(() => bridge.approvalPhaseForTest() === "editing", "phase editing after approval");
    bridge.relay({ type: "result", subtype: "success" });
    await until(() => bridge.approvalPhaseForTest() === "idle", "phase idle after a turn whose capture threw");
    check("a turn whose post-edit capture throws still frees the approval phase",
      bridge.approvalPhaseForTest() === "idle", bridge.approvalPhaseForTest());

    bridge.setSnapshotForTest(null);
    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // A snapshotFn that REJECTS (not just returns null) must not latch the phase at
    // "snapshotting" or leak an unhandled rejection: the approval is refused, the
    // phase returns to idle, and the next approval still works.
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    bridge.setSnapshotForTest(() => Promise.reject(new Error("snapshot exploded")));
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "doomed snapshot", ref: 1, declarations: "color:red", element: {} });
    let refused = false;
    for (let i = 0; i < 200 && !refused; i++) {
      refused = p.sent.some((f) => f.kind === "approval_rejected" && f.label === "doomed snapshot");
      if (!refused) await new Promise((r) => setTimeout(r, 10));
    }
    check("a rejecting snapshotFn refuses the approval and returns the phase to idle",
      refused && bridge.approvalPhaseForTest() === "idle",
      `refused=${refused} phase=${bridge.approvalPhaseForTest()}`);

    // And a later approval still works — the failure didn't wedge the machine.
    bridge.setSnapshotForTest(() => ({ ref: "HEAD", label: "x", at: Date.now(), untrackedBefore: [], untrackedBlobs: {} }));
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "after failure", ref: 2, declarations: "color:blue", element: {} });
    await untilPhase("editing");
    check("approvals still work after a snapshot failure",
      p.sent.some((f) => f.kind === "revertable" && f.label === "after failure"), JSON.stringify(p.sent.map((f) => f.kind)));
    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");

    bridge.setSnapshotForTest(null);
    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  {
    // Off mode (an MCP client drives) has no local turn to end, so the phase must
    // not latch: the first approval is relayed and the second must be too, not
    // refused as "still applying the previous change".
    const p = makePage();
    bridge.setAgentForTest("off");
    p.sent.length = 0;
    p.deliver({ kind: "approval", label: "first (mcp)", ref: 1, declarations: "color:red", element: {} });
    await until(() => bridge.approvalPhaseForTest() === "idle", "phase idle after an off-mode approval");
    p.deliver({ kind: "approval", label: "second (mcp)", ref: 2, declarations: "color:blue", element: {} });
    await new Promise((r) => setTimeout(r, 30));
    check("a second approval in off mode is relayed, not refused",
      !p.sent.some((f) => f.kind === "approval_rejected" && f.label === "second (mcp)"),
      JSON.stringify(p.sent.map((f) => f.kind)));

    bridge.setAgentForTest("builtin");
    await bridge.clearSession();
    p.close();
  }

  {
    // Off mode: the MCP client edits source in its own editor, invisible to the
    // bridge, then sends note_edit once it has committed the approved change. That
    // signal is what lets undo scope to those files — before it, undo declines the
    // same way it would mid-turn; after it, undo restores the change.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setAgentForTest("off");
    writeFileSync(join(proj, "mcp-edit.css"), ".m { color: red }\n");
    execFileSync("git", ["add", "."], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "mcp baseline"], { cwd: proj });

    p.deliver({ kind: "approval", label: "mcp change", ref: 1, declarations: "color: blue", element: {} });
    await until(() => bridge.approvalPhaseForTest() === "idle", "the off-mode approval to settle");
    writeFileSync(join(proj, "mcp-edit.css"), ".m { color: blue }\n"); // the MCP client's own edit

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the pre-signal revert to answer");
    check("in off mode, undo declines until the client says it committed the edit",
      p.sent.find((f) => f.kind === "reverted")?.ok === false,
      JSON.stringify(p.sent.find((f) => f.kind === "reverted")));

    p.deliver({ kind: "note_edit" });
    await until(() => bridge.approvalCapturedForTest(), "the post-edit state to be recorded");

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the post-signal revert to answer");
    const reverted = p.sent.find((f) => f.kind === "reverted");
    check("after note_edit, undo restores the MCP-committed change",
      reverted?.ok === true && reverted.files?.includes("mcp-edit.css"), JSON.stringify(reverted));
    check("and the file is back to its pre-approval contents",
      readFileSync(join(proj, "mcp-edit.css"), "utf8") === ".m { color: red }\n",
      readFileSync(join(proj, "mcp-edit.css"), "utf8").trim());

    bridge.setAgentForTest("builtin");
    await bridge.clearSession();
    p.close();
  }

  {
    // Off mode with a file list: note_edit may name the files the MCP client changed,
    // so undo scopes to exactly those instead of the whole diff — a file the user
    // edited in the same window is then left alone. A path outside the project is
    // ignored, not restored.
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setAgentForTest("off");
    writeFileSync(join(proj, "mcp-agent.css"), "a: 1\n");
    writeFileSync(join(proj, "mcp-user.css"), "u: 1\n");
    execFileSync("git", ["add", "."], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "mcp scoped baseline"], { cwd: proj });

    p.deliver({ kind: "approval", label: "scoped mcp change", ref: 1, declarations: "color: blue", element: {} });
    await until(() => bridge.approvalPhaseForTest() === "idle", "the off-mode approval to settle");
    writeFileSync(join(proj, "mcp-agent.css"), "a: 2\n"); // the MCP client's committed edit
    writeFileSync(join(proj, "mcp-user.css"), "u: 2\n"); // the user's own edit in the same window

    // The client names only its own file (plus a path outside the root, which is ignored).
    p.deliver({ kind: "note_edit", files: ["mcp-agent.css", "../outside.css"] });
    await until(() => bridge.approvalCapturedForTest(), "the scoped post-edit state to be recorded");

    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the scoped revert to answer");
    const out = p.sent.find((f) => f.kind === "reverted");
    check("a file-scoped note_edit restores only the named file",
      out.ok === true && out.files?.includes("mcp-agent.css") && !out.files?.includes("mcp-user.css") &&
        readFileSync(join(proj, "mcp-agent.css"), "utf8") === "a: 1\n", JSON.stringify(out));
    check("and leaves the user's concurrently-edited file alone",
      readFileSync(join(proj, "mcp-user.css"), "utf8") === "u: 2\n",
      readFileSync(join(proj, "mcp-user.css"), "utf8").trim());

    bridge.setAgentForTest("builtin");
    await bridge.clearSession();
    execFileSync("git", ["checkout", "--", "mcp-user.css"], { cwd: proj });
    p.close();
  }

  {
    // An internal ask (compaction/clear) queued behind an open turn must still time
    // out if that turn never ends — otherwise its promise leaks and the compaction
    // that awaits it wedges. Open a turn that never resolves, then queue an ask
    // behind it and prove it rejects on its own timeout rather than hanging.
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    bridge.pushToAgent("open a turn that never ends"); // builtinTurnOpen = true, no result relayed
    const t0 = Date.now();
    const outcome = await Promise.race([
      bridge.askAgent("queued while a turn is open", 80).then(() => "resolved", () => "rejected"),
      new Promise((r) => setTimeout(() => r("hung"), 1500)),
    ]);
    check("an internal ask queued behind an open turn still times out, never leaks",
      outcome === "rejected" && Date.now() - t0 >= 70, `${outcome} after ${Date.now() - t0}ms`);

    bridge.relay({ type: "result", subtype: "success" }); // close the dangling turn
    bridge.setSessionForTest(null);
    await bridge.clearSession();
  }

  // -------------------------------------------------- the OpenCode agent loop
  // runOpencode drives an OpenCode session over the SDK's HTTP client and relays
  // its event stream into the panel. Fake the SDK — the seam createAdapter gives
  // as fetchImpl — so the whole loop runs offline, no `opencode` binary needed.
  {
    // A pushable async-iterable, standing in for client.event.subscribe's stream.
    const makeStream = () => {
      const queued = [];
      let waiting = null;
      let closed = false;
      return {
        push: (ev) => (waiting ? (waiting({ value: ev, done: false }), (waiting = null)) : queued.push(ev)),
        end: () => (closed = true, waiting && (waiting({ value: undefined, done: true }), (waiting = null))),
        [Symbol.asyncIterator]: () => ({
          next: () =>
            queued.length
              ? Promise.resolve({ value: queued.shift(), done: false })
              : closed
                ? Promise.resolve({ value: undefined, done: true })
                : new Promise((r) => (waiting = r)),
        }),
      };
    };

    const p = makePage();
    const stream = makeStream();
    const calls = { prompts: [], permissions: [] };
    const client = {
      session: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "S" } }),
        promptAsync: async ({ body }) => (calls.prompts.push(body), { data: {} }),
      },
      event: { subscribe: async () => ({ stream }) },
      postSessionIdPermissionsPermissionId: async ({ path }) => (calls.permissions.push(path.permissionID), { data: {} }),
    };
    bridge.setOpencodeForTest(async () => ({
      createOpencodeClient: () => client,
      createOpencode: async () => ({ server: { url: "http://fake", close: () => {} } }),
    }));
    bridge.setAgentForTest("opencode");
    // A config that names uitalk skips runOpencode's "not wired to MCP" warning.
    writeFileSync(join(process.env.UITALK_PROJECT, "opencode.jsonc"), '{ "mcp": { "uitalk": {} } }\n');

    await bridge.runOpencode();
    check("an OpenCode session is announced ready to the panel",
      p.sent.some((f) => f.kind === "status" && /opencode/.test(f.text)), JSON.stringify(p.sent.map((f) => f.kind)));

    // A full turn: prompt -> assistant message -> text delta -> a tool -> idle.
    p.sent.length = 0;
    bridge.transcript.length = 0;
    bridge.pushToAgent("make the header bold");
    await until(() => calls.prompts.length === 1, "the prompt to reach OpenCode");
    stream.push({ type: "message.updated", properties: { info: { id: "m1", sessionID: "S", role: "assistant" } } });
    stream.push({ type: "message.part.delta", properties: { sessionID: "S", messageID: "m1", partID: "t1", field: "text", delta: "I edited Header.tsx." } });
    stream.push({ type: "message.part.updated", properties: { part: { type: "tool", callID: "c1", tool: "edit_file", sessionID: "S", messageID: "m1", state: { status: "completed" } } } });
    // A write tool names the path it touched; a read tool with a path does not get
    // recorded (reading a file must never make undo revert it).
    stream.push({ type: "message.part.updated", properties: { part: { type: "tool", callID: "w1", tool: "edit", sessionID: "S", messageID: "m1", state: { status: "completed", input: { filePath: "oc-styles.css" } } } } });
    stream.push({ type: "message.part.updated", properties: { part: { type: "tool", callID: "r1", tool: "read", sessionID: "S", messageID: "m1", state: { status: "completed", input: { filePath: "oc-readonly.css" } } } } });
    stream.push({ type: "session.idle", properties: { sessionID: "S" } });
    await until(() => p.sent.some((f) => f.kind === "turn_end"), "the OpenCode turn to end");
    check("the model's streamed text reaches the panel", p.sent.some((f) => f.kind === "delta" && /edited Header/.test(f.text)),
      JSON.stringify(p.sent.map((f) => f.kind)));
    check("a tool the model used is named in the panel",
      p.sent.some((f) => f.kind === "tool" && f.name === "edit_file"), JSON.stringify(p.sent.map((f) => f.kind)));
    check("the finished turn is recorded for replay",
      bridge.transcript.some((t) => t.role === "agent" && /edited Header/.test(t.text)), JSON.stringify(bridge.transcript));

    check("an OpenCode write tool's path is recorded, a read tool's is not",
      bridge.turnWritesForTest().paths.includes("oc-styles.css") && !bridge.turnWritesForTest().paths.includes("oc-readonly.css"),
      JSON.stringify(bridge.turnWritesForTest()));

    // text a delta already covered is not double-relayed by the part's final update.
    p.sent.length = 0;
    bridge.pushToAgent("again");
    await until(() => calls.prompts.length === 2, "the second prompt");
    stream.push({ type: "message.updated", properties: { info: { id: "m2", sessionID: "S", role: "assistant" } } });
    stream.push({ type: "message.part.delta", properties: { sessionID: "S", messageID: "m2", partID: "t2", field: "text", delta: "done" } });
    stream.push({ type: "message.part.updated", properties: { part: { type: "text", id: "t2", text: "done", sessionID: "S", messageID: "m2" } } });
    stream.push({ type: "session.idle", properties: { sessionID: "S" } });
    await until(() => p.sent.some((f) => f.kind === "turn_end"), "the second turn to end");
    check("a part's final update does not re-send text its deltas already sent",
      p.sent.filter((f) => f.kind === "delta").length === 1, JSON.stringify(p.sent.filter((f) => f.kind === "delta")));

    // A session error surfaces and still ends the turn.
    p.sent.length = 0;
    bridge.pushToAgent("break it");
    await until(() => calls.prompts.length === 3, "the third prompt");
    stream.push({ type: "session.error", properties: { sessionID: "S", error: { message: "model exploded" } } });
    await until(() => p.sent.some((f) => f.kind === "error"), "the error to surface");
    check("a session error is surfaced and still ends the turn",
      p.sent.some((f) => f.kind === "error" && /exploded/.test(f.text)) && p.sent.some((f) => f.kind === "turn_end"),
      JSON.stringify(p.sent.map((f) => f.kind)));

    // A permission request is auto-approved (edits are gated by uitalk's approval upstream).
    stream.push({ type: "permission.updated", properties: { sessionID: "S", id: "perm1" } });
    await until(() => calls.permissions.includes("perm1"), "the permission to be approved");
    check("an OpenCode permission request is auto-approved", calls.permissions.includes("perm1"), JSON.stringify(calls.permissions));

    // send() must serialize on turn COMPLETION, not prompt dispatch. A second
    // message that arrives while the first turn is still streaming must not start
    // (and overwrite) a new turn: its prompt must wait until the first turn idles.
    p.sent.length = 0;
    calls.prompts.length = 0;
    bridge.pushToAgent("first of two");
    await until(() => calls.prompts.length === 1, "the first of two prompts to dispatch");
    bridge.pushToAgent("second of two"); // queued while the first turn is still open
    await new Promise((r) => setTimeout(r, 60)); // give the queue a chance to wrongly run it
    check("a second message does not dispatch its prompt until the first turn ends",
      calls.prompts.length === 1, `${calls.prompts.length} prompts dispatched`);
    stream.push({ type: "message.updated", properties: { info: { id: "mS", sessionID: "S", role: "assistant" } } });
    stream.push({ type: "message.part.delta", properties: { sessionID: "S", messageID: "mS", partID: "tS", field: "text", delta: "first done" } });
    stream.push({ type: "session.idle", properties: { sessionID: "S" } }); // end turn one
    await until(() => calls.prompts.length === 2, "the second prompt once the first turn ends");
    check("the second message dispatches only after the first turn has ended", calls.prompts.length === 2);
    stream.push({ type: "session.idle", properties: { sessionID: "S" } }); // end turn two, leave state clean
    await until(() => p.sent.filter((f) => f.kind === "turn_end").length >= 2, "both turns to end");

    // If the event stream ends WITHOUT a final idle/error (a graceful SSE close),
    // a turn still in flight must not spin forever — its send() queue step would
    // never resolve and wedge every later turn. Start a turn, end the stream, and
    // confirm the turn is ended rather than left open.
    p.sent.length = 0;
    bridge.pushToAgent("a turn the stream will abandon");
    await until(() => calls.prompts.length === 3, "the third prompt to dispatch");
    stream.end(); // graceful close, no idle/error
    await until(() => p.sent.some((f) => f.kind === "turn_end"), "the abandoned turn to be ended when the stream closes");
    check("a turn is ended when the OpenCode stream closes without a final event",
      p.sent.some((f) => f.kind === "turn_end"), JSON.stringify(p.sent.map((f) => f.kind)));

    bridge.setOpencodeForTest(null);
    bridge.setAgentForTest("builtin");
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

  // ------------------------------------------------- role-classification window
  // A socket is in `clients` the instant it connects, before it has said whether
  // it is a page or an MCP agent. A page RPC must not be routed to such an
  // unclassified socket — it could be an MCP client that cannot answer. Start from
  // an empty set so the fallback (not activePage) is what's exercised.
  {
    for (const c of [...bridge.clients]) c.close();

    const unclassified = makePage(); // connected, has announced nothing yet
    unclassified.sent.length = 0;
    let rejected = null;
    await bridge.callPage("readSelection", {}, 200).catch((e) => (rejected = e.message));
    check("a page RPC is refused, not routed to an unclassified socket",
      /no page is connected/.test(rejected ?? "") && !unclassified.sent.some((f) => f.kind === "rpc"),
      `${rejected} · sent=${JSON.stringify(unclassified.sent.map((f) => f.kind))}`);

    // Once it announces itself as a page it becomes a valid RPC target.
    unclassified.deliver({ kind: "focus", url: "http://127.0.0.1:8400/", visible: true });
    unclassified.sent.length = 0;
    const inflight = bridge.callPage("readSelection", {}, 500);
    check("a socket that has announced itself as a page does receive the RPC",
      unclassified.sent.some((f) => f.kind === "rpc"), JSON.stringify(unclassified.sent.map((f) => f.kind)));
    const rpc = unclassified.sent.find((f) => f.kind === "rpc");
    if (rpc) unclassified.deliver({ kind: "rpc_result", id: rpc.id, result: {} });
    await inflight;

    // A socket that declares itself an agent is never used as the page fallback.
    const agentish = makePage();
    agentish.deliver({ kind: "hello", role: "agent" });
    unclassified.close();
    agentish.sent.length = 0;
    let noPage = null;
    await bridge.callPage("readSelection", {}, 200).catch((e) => (noPage = e.message));
    check("an agent socket is never the page fallback",
      /no page is connected/.test(noPage ?? "") && !agentish.sent.some((f) => f.kind === "rpc"),
      `${noPage} · sent=${JSON.stringify(agentish.sent.map((f) => f.kind))}`);
    agentish.close();
  }

  // ------------------------------------------------- precise undo (builtin mode)
  // The built-in session names the files it writes in its tool_use events; undo
  // scopes to those, so a file the user edits while the agent works is not swept
  // in. End to end: approve, the agent edits A (a tool_use), the user edits B, the
  // turn ends, undo restores A and leaves B.
  {
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    writeFileSync(join(proj, "agent-wrote.css"), "x: 1\n");
    writeFileSync(join(proj, "user-wrote.css"), "y: 1\n");
    execFileSync("git", ["add", "."], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "precise baseline"], { cwd: proj });

    p.deliver({ kind: "approval", label: "precise change", ref: 1, declarations: "color:red", element: {} });
    await untilPhase("editing");
    // the agent edits agent-wrote.css (announced via a Write tool_use) …
    bridge.relay({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(proj, "agent-wrote.css") } }] } });
    writeFileSync(join(proj, "agent-wrote.css"), "x: 2\n");
    // … while the user edits user-wrote.css in the same window (no tool_use for it)
    writeFileSync(join(proj, "user-wrote.css"), "y: 2\n");
    check("only the agent's tool_use path is recorded as written",
      bridge.turnWritesForTest().paths.includes("agent-wrote.css") && !bridge.turnWritesForTest().paths.includes("user-wrote.css"),
      JSON.stringify(bridge.turnWritesForTest()));

    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");
    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the revert to answer");
    const out = p.sent.find((f) => f.kind === "reverted");
    check("undo restores the file the agent wrote", out.ok === true && out.files?.includes("agent-wrote.css") &&
      readFileSync(join(proj, "agent-wrote.css"), "utf8") === "x: 1\n", JSON.stringify(out));
    check("and leaves the file the user edited concurrently alone",
      !out.files?.includes("user-wrote.css") && readFileSync(join(proj, "user-wrote.css"), "utf8") === "y: 2\n",
      readFileSync(join(proj, "user-wrote.css"), "utf8").trim());

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  // --------------------------------- write attribution: complete vs incomplete
  // The write set is only trusted (scoped) when it is COMPLETE — every tool was a
  // structured write or a known read. A shell/opaque tool marks it incomplete, so
  // undo falls back to the full diff instead of silently missing that tool's writes.
  {
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    const scenario = async (label, content) => {
      p.deliver({ kind: "approval", label, ref: 1, declarations: "color:red", element: {} });
      await untilPhase("editing");
      bridge.relay({ type: "assistant", message: { content } });
      const w = bridge.turnWritesForTest();
      bridge.relay({ type: "result", subtype: "success" });
      await untilPhase("idle");
      return w;
    };
    const tool = (name, input) => ({ type: "tool_use", name, input });

    const structured = await scenario("structured only", [tool("Edit", { file_path: join(proj, "A.css") }), tool("Write", { file_path: join(proj, "B.css") })]);
    check("only structured edits → complete, scoped to those paths",
      structured.complete && structured.paths.includes("A.css") && structured.paths.includes("B.css"), JSON.stringify(structured));

    const shellOnly = await scenario("shell only", [tool("Bash", { command: "sed -i s/a/b/ x.css" })]);
    check("a shell/opaque tool → incomplete, so undo falls back to the full diff",
      shellOnly.complete === false && shellOnly.paths.length === 0, JSON.stringify(shellOnly));

    const mixed = await scenario("structured + shell", [tool("Edit", { file_path: join(proj, "A.css") }), tool("Bash", { command: "echo x >> B.css" })]);
    check("structured edit + shell → incomplete even though a path was recorded",
      mixed.complete === false && mixed.paths.includes("A.css"), JSON.stringify(mixed));

    const reads = await scenario("no known writes", [tool("Read", { file_path: join(proj, "A.css") }), tool("Grep", { pattern: "x" })]);
    check("only reads → complete with no paths (captureAfter then uses the full diff)",
      reads.complete === true && reads.paths.length === 0, JSON.stringify(reads));

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    p.close();
  }

  // End to end: the dangerous case — the agent edits one file through a structured
  // tool and another through shell. Undo must restore BOTH; scoping to the recorded
  // path alone (the old behavior) silently left the shell-written file changed.
  {
    const proj = process.env.UITALK_PROJECT;
    const p = makePage();
    bridge.setSessionForTest({
      mode: "builtin", label: "claude",
      summarize: (r) => bridge.askAgent(r, 5000),
      clear: () => bridge.askAgent("/clear", 5000),
    });
    writeFileSync(join(proj, "struct.css"), "a: 1\n");
    writeFileSync(join(proj, "shell.css"), "b: 1\n");
    execFileSync("git", ["add", "."], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "attribution baseline"], { cwd: proj });

    p.deliver({ kind: "approval", label: "mixed edit", ref: 1, declarations: "color:red", element: {} });
    await untilPhase("editing");
    bridge.relay({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Edit", input: { file_path: join(proj, "struct.css") } },
      { type: "tool_use", name: "Bash", input: { command: "printf 'b: 2\\n' > shell.css" } },
    ] } });
    writeFileSync(join(proj, "struct.css"), "a: 2\n"); // the structured edit
    writeFileSync(join(proj, "shell.css"), "b: 2\n"); // the shell-written file the bridge can't attribute

    bridge.relay({ type: "result", subtype: "success" });
    await untilPhase("idle");
    p.sent.length = 0;
    p.deliver({ kind: "revert" });
    await until(() => p.sent.some((f) => f.kind === "reverted"), "the revert to answer");
    const out = p.sent.find((f) => f.kind === "reverted");
    check("undo restores BOTH the structured edit and the shell-written file",
      out.ok === true && out.files?.includes("struct.css") && out.files?.includes("shell.css") &&
        readFileSync(join(proj, "struct.css"), "utf8") === "a: 1\n" &&
        readFileSync(join(proj, "shell.css"), "utf8") === "b: 1\n",
      JSON.stringify({ out, shell: readFileSync(join(proj, "shell.css"), "utf8").trim() }));

    bridge.setSessionForTest(null);
    await bridge.clearSession();
    execFileSync("git", ["rm", "-q", "struct.css", "shell.css"], { cwd: proj });
    execFileSync("git", ["commit", "-qm", "cleanup attribution"], { cwd: proj });
    p.close();
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

  const TOKEN = bridge.socketToken;
  const tryConnect = ({ origin, token = TOKEN } = {}) => new Promise((resolve) => {
    const opts = origin ? { headers: { Origin: origin } } : {};
    const query = token === null ? "" : `?token=${token}`;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/__uitalk/socket${query}`, opts);
    sock.on("open", () => {
      resolve({ ok: true });
      sock.close();
    });
    sock.on("unexpected-response", (req, res) => resolve({ ok: false, status: res.statusCode }));
    sock.on("error", () => resolve({ ok: false, status: null }));
  });

  // Origin is checked first: a remote origin is refused even with a valid token.
  const evil = await tryConnect({ origin: "https://evil.example" });
  check("a socket upgrade from an untrusted remote origin is refused",
    evil.ok === false && evil.status === 403, JSON.stringify(evil));

  // The capability token gates every connection, whatever the (allowed) origin.
  const noToken = await tryConnect({ origin: `http://127.0.0.1:${port}`, token: null });
  check("a loopback socket upgrade with no token is refused",
    noToken.ok === false && noToken.status === 403, JSON.stringify(noToken));

  const wrongToken = await tryConnect({ origin: `http://127.0.0.1:${port}`, token: "deadbeef".repeat(6) });
  check("a loopback socket upgrade with the wrong token is refused",
    wrongToken.ok === false && wrongToken.status === 403, JSON.stringify(wrongToken));

  // Another local app cannot connect: it has a loopback origin but not the token.
  const otherApp = await tryConnect({ origin: "http://localhost:3000", token: null });
  check("another localhost app (loopback origin, no token) cannot open the socket",
    otherApp.ok === false && otherApp.status === 403, JSON.stringify(otherApp));

  // With the real token, the legitimate clients all still connect.
  const none = await tryConnect({ origin: null });
  check("no Origin (MCP and other non-browser clients) with the token is allowed",
    none.ok === true, JSON.stringify(none));

  const own = await tryConnect({ origin: `http://127.0.0.1:${port}` });
  check("the bridge's own origin with the token is allowed",
    own.ok === true, JSON.stringify(own));

  const bookmarklet = await tryConnect({ origin: "http://localhost:5173" });
  check("another loopback port (the bookmarklet's dev server) with the token is allowed",
    bookmarklet.ok === true, JSON.stringify(bookmarklet));

  // The token must never travel in the shared bundle — it is only readable from
  // the injecting tag, so a cross-origin <script src> of client.js cannot harvest it.
  check("the token is not baked into the served client.js bundle",
    !bridge.readClient().body.includes(TOKEN), "token found in bundle body");

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
