# @oh-my-pi/collab-web

Internal build-time source for the rich tool cards embedded in standalone Agent Runtime HTML exports. Despite the historical package name, it no longer contains a browser guest client, collaboration UI, relay, composer, or deployable web application.

## Generate the embedded renderer

```sh
bun run gen:tool-views
```

The generator bundles `src/tool-render/standalone.tsx`, React, and the renderer stylesheet into `packages/coding-agent/src/export/html/tool-views.generated.js`. The resulting web component is embedded directly in exported HTML, so the export has no runtime dependency on this package or an external UI service.

## Retained boundary

- `src/tool-render/` contains export-only React renderers for tool-call payloads.
- `scripts/build-tool-views.ts` is the single asset-generation entrypoint.
- `test/tool-view.test.tsx` protects renderer output contracts.

Collaboration wire types and the Agent Runtime host protocol remain in their headless packages; this package does not implement either protocol.
