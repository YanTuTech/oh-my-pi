# Plugin manager Runtime plumbing

Plugin discovery and installation remain headless Runtime capabilities. The removed OMP CLI command adapters and selectors are not part of this path.

## Sources

- `src/extensibility/plugins/manager.ts`
- `src/extensibility/plugins/installer.ts`
- `src/extensibility/plugins/doctor.ts`
- `src/extensibility/plugins/lock.ts`
- `src/extensibility/plugins/legacy-pi-compat.ts`
- `src/extensibility/extensions/loader.ts`
- `src/capability/`

## Manager contract

`PluginManager` validates plugin identifiers and scopes, resolves npm/link sources, applies lockfile and filesystem safety checks, materializes plugin content, and invalidates discovery caches. Hosts call this API directly or expose it through their own RPC/application workflow.

Mutations are explicit and scoped. The manager must reject path traversal, unsafe links, mismatched package identity, invalid manifests, and concurrent lock conflicts.

## Runtime activation

Installing files does not retroactively rebuild every initialized capability in a live AgentSession. Hosts may refresh skills and commands where supported, then create or restart a session when new tools, hooks, MCP servers, or extension modules must enter the capability graph.

## Compatibility

Legacy Pi extension resolution is retained because it is part of the extension-loading contract, including installed-package path handling. Removing user-facing CLI code must not remove or rewrite that compatibility layer without separate behavioral evidence.
