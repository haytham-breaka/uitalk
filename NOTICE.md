# Third-party notices

This project contains no code derived from any other project. Every mechanism in
it — the injecting reverse proxy, the preview layer, the capture paths, the
selection model, the agent tool surface — was written for this repository.

It depends on three packages at runtime, used unmodified through their public
APIs and not vendored:

| Package | Licence | Used for |
|---|---|---|
| [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | See package | Running the agent session and its in-process MCP tools |
| [`ws`](https://www.npmjs.com/package/ws) | MIT | The bridge's WebSocket server |
| [`zod`](https://www.npmjs.com/package/zod) | MIT | Tool input schemas |

Development only: [`c8`](https://www.npmjs.com/package/c8) (ISC) and
[`jsdom`](https://www.npmjs.com/package/jsdom) (MIT).
