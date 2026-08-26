# Agent Runtime package boundary

This page records which workspace packages form the shipped headless Runtime and which packages are development or external integration tooling.

The normative, automatically enforced boundary is documented in [Agent Runtime boundary](runtime-boundary.md) and encoded in [`runtime-boundary.json`](../runtime-boundary.json). This page describes the package roles within that boundary.

## Shipped Runtime packages

| Package | Runtime responsibility |
|---|---|
| `@oh-my-pi/pi-coding-agent` | SDK, sessions, tools, extensions, RPC/ACP hosts, and HTML export |
| `@oh-my-pi/pi-agent-core` | Agent state machine and tool-call lifecycle |
| `@oh-my-pi/pi-ai` | Provider clients and streaming |
| `@oh-my-pi/pi-catalog` | Model/provider catalog and identity |
| `@oh-my-pi/pi-natives` plus platform leaf | Native acceleration and system adapters |
| `@oh-my-pi/pi-mnemopi` | Local memory engine |
| `@oh-my-pi/omp-stats` | Headless session analytics |
| `@oh-my-pi/pi-wire` | Collaboration and host protocol contracts |
| `@oh-my-pi/omptype` | Runtime schemas |
| `@oh-my-pi/pi-utils` | Shared infrastructure |
| `@oh-my-pi/hashline` | Edit language and applier |
| `@oh-my-pi/snapcompact` | Context compaction support |

None of these packages installs an end-user executable or bundles a UI.

## Build-time HTML renderer source

`packages/collab-web` is private and contains only the React tool renderers used to generate `packages/coding-agent/src/export/html/tool-views.generated.js`. It is not a browser client, server, relay, or published Runtime dependency.

## Development-only packages

Benchmark harnesses, fixture generators, release scripts, and the self-hosted `python/robomp` service are repository development/integration projects. They are not imported by the Agent Runtime public surface and are not evidence of a bundled Runtime UI.

## Browser automation extension

`packages/browser-relay` is a transport used by the Runtime browser tool to attach to existing Chrome tabs. Its extension artifact is a tool capability, not an Agent Runtime application UI. The Runtime may also launch or attach to headless Chromium without this transport.

## Publication contract

Release publication produces npm packages, native platform leaves, license material, and the browser-tool relay extension. The removed standalone `omp` binary, Homebrew formula, installer scripts, Nix application/module outputs, stats dashboard, Mnemopi CLI, TUI, and browser collaboration guest are not release artifacts.

The install smoke packs the workspace, installs it into a clean temporary project, verifies Runtime/RPC/ACP/HTML imports and native-leaf resolution, and asserts that no `node_modules/.bin/omp` exists.
