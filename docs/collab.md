# Collaboration Runtime protocol

The Agent Runtime retains the encrypted live-session protocol and host-side collaboration machinery. It does not include a terminal guest, browser guest, connect screen, composer, or relay UI.

## Package boundary

- `@oh-my-pi/pi-wire` defines versioned frame shapes, relay constants, and compatibility types.
- `packages/coding-agent/src/collab/` implements headless host state, encryption, replication, and Runtime event projection.
- RPC/ACP or an embedding application may expose collaboration through its own UI.
- `packages/collab-web/src/tool-render/` is unrelated to the live guest client; it is retained only to generate rich tool cards embedded in standalone HTML exports.

## Security model

A collaboration link identifies a relay room and carries an encryption key. The relay routes opaque frames and does not receive the key. Hosts and authorized guests encrypt/decrypt frames end to end.

Treat a complete room link as a bearer credential. A host should avoid logging it, persisting it in analytics, or sending it through unrelated services. Relay authentication and room authorization do not replace end-to-end payload encryption.

## Runtime flow

1. The host creates a room and negotiates the current `COLLAB_PROTO` version.
2. The host projects session state and live Runtime events into encrypted frames.
3. A compatible external guest replica applies durable entries and live message updates.
4. Guest actions such as prompt, interrupt, or subagent control arrive as authenticated protocol requests.
5. The host validates the action and invokes the corresponding Agent Runtime capability.

The coding-agent package keeps this protocol so Research Buddy can provide collaboration without inheriting the removed OMP interfaces.

## Durable and live state

Durable session entries and live message deltas are separate frame classes. A replica must preserve entry ids and ordering, tolerate reconnect/replay, and synthesize missing live starts only when the protocol provides enough accumulated state. Session files and blob references remain host-owned.

Subagent state is represented through the wire contract rather than a bundled panel. Host applications choose how to display agent rosters, transcripts, steering, revive, and kill actions.

## Relay boundary

The repository no longer ships the historical local relay script or browser static client. Production or application-specific relays are external infrastructure and must implement the retained `@oh-my-pi/pi-wire` contract.

The separate `packages/browser-relay` package is a Chrome automation transport for the browser tool; it is not the collaboration relay.

## Compatibility

Do not change frame names, required fields, encryption layout, or protocol version as part of UI removal. Protocol changes require explicit versioning and interoperability tests. UI-specific labels, themes, keyboard handling, and rendering are outside this contract.
