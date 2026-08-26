# hello-extension

A minimal `oh-my-pi` extension that demonstrates the two most common authoring patterns: subscribing to `session_start` to notify on load, and registering a `/hello` slash command that sends a greeting into the conversation. It is intentionally small — use it as a copy-paste starting point for your own extension.

## Install

**Option A — drop into user extensions directory:**

```
cp -r . ~/.omp/agent/extensions/hello-extension
```

Restart the embedding Runtime host. The host receives the startup notification immediately.

With `OMP_PROFILE=<name>`, use `~/.omp/profiles/<name>/agent/extensions/hello-extension` instead. `PI_CODING_AGENT_DIR` likewise changes the agent directory.

**Option B — point the settings `extensions` array at it:**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**Option C — load for one SDK session:**

```ts
await createAgentSession({
  additionalExtensionPaths: ["./hello-extension"],
});
```

## Usage

After loading, execute `/hello` or `/hello Ada` through the host command surface. The command sends a greeting custom message into the conversation and emits a "Message sent!" host notification.

## What it demonstrates

- Default export factory receiving `ExtensionAPI`
- `pi.on("session_start", ...)` — session lifecycle hook
- `pi.registerCommand(...)` — slash command registration
- `ctx.ui.notify(...)` — user-facing notification
- `package.json` with `omp.extensions` manifest field
