// The page tools, as the Claude Agent SDK wants them.
//
// The definitions themselves live in tool-defs.mjs and are shared with the
// standalone MCP server: two copies of eleven tool descriptions would drift, and the
// descriptions are the part an agent actually reads.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolDefinitions } from "./tool-defs.mjs";

/** The shared schema shape, as zod. Everything is optional unless declared required. */
function toZod(def) {
  const build = (spec) => {
    switch (spec.type) {
      case "number":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(spec.items ? build(spec.items) : z.any());
      case "object":
        return z.object(
          Object.fromEntries(
            Object.entries(spec.properties ?? {}).map(([k, v]) => {
              const inner = build(v);
              return [k, (spec.required ?? []).includes(k) ? inner : inner.optional()];
            }),
          ),
        );
      default:
        return z.string();
    }
  };

  return Object.fromEntries(
    Object.entries(def.schema ?? {}).map(([name, spec]) => {
      let field = build(spec);
      if (spec.description) field = field.describe(spec.description);
      return [name, (def.required ?? []).includes(name) ? field : field.optional()];
    }),
  );
}

/**
 * @param {(method: string, params?: unknown, timeout?: number) => Promise<any>} callPage
 * @param {(method: string, message: string) => void} [report] surfaces failures in the
 *   panel too. Without it a tool failure is visible only to the agent, and the user
 *   sees whatever the agent decides to say about it — which may be a guess.
 * @param {((path: string, needles: string[]) => any) | null} [findInHtml]
 * @param {((name: string, definingFile: string) => any) | null} [countUsages]
 * @param {((needles: string[]) => any[]) | null} [findSourceCandidates]
 */
export function createPageServer(callPage, report = () => {}, findInHtml = null, countUsages = null, findSourceCandidates = null) {
  const defs = toolDefinitions(callPage, report, findInHtml, countUsages, findSourceCandidates);

  return createSdkMcpServer({
    name: "page",
    version: "0.1.0",
    tools: defs.map((def) =>
      tool(def.name, def.description, toZod(def), (args) => def.run(args ?? {}), {
        annotations: { readOnlyHint: Boolean(def.readOnly) },
        ...(def.always ? { alwaysLoad: true } : {}),
      }),
    ),
  });
}
