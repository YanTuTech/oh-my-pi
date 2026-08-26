# Tool approval mode

Tool approval has three inputs:

1. **Tool declaration** — every tool may declare an `approval` tier:
   - `read`: reads data or updates host-facing session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **Tool policy** — object-form declarations may set `policy: allow | deny | prompt`, optionally with `override` and a reason. This is used for argument-dependent safety/pattern rules.
3. **User policy** — `tools.approval.<toolName>: allow | deny | prompt` overrides the active mode, but cannot bypass a tool's own deny/prompt policy or a non-yolo safety override.

Tools without an `approval` declaration, and malformed approval decisions, are treated as `exec`. This is the safe default for unknown custom tools. MCP server tools declare `write`.

## Modes

Configure with `tools.approvalMode`:

| Mode             | Auto-approves           | Prompts for     |
| ---------------- | ----------------------- | --------------- |
| `always-ask`     | `read`                  | `write`, `exec` |
| `write`          | `read`, `write`         | `exec`          |
| `yolo` (default) | `read`, `write`, `exec` | none            |

The Runtime RPC host's `--auto-approve` option forces `tools.approvalMode: yolo` for that process.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

Resolution per tool call:

1. Evaluate `tool.approval(args)`; omitted/malformed decisions default to tier `exec`.
2. A tool-declared `policy: deny` always denies. A user `deny` is checked next and also always denies.
3. In `yolo`, an explicit tool `allow`/`prompt` policy wins; otherwise the valid user policy wins, or the call is allowed. The `override` flag alone does not force a prompt in `yolo`.
4. In non-yolo modes, an `override: true` decision allows only an accompanying tool `policy: allow`; every other non-denied case prompts.
5. Without an override, an explicit tool `allow`/`prompt` policy wins, then a valid user policy wins.
6. With no explicit policy, the active mode auto-approves or prompts by tier.

Policy strings are trimmed and case-normalized. Invalid user values are ignored.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. It also supports configured `bash.patterns` rules: `deny` is absolute, `prompt` forces a prompt, and `allow` explicitly allows the matching call at the `write` tier. Reasons appear in the approval prompt. In `yolo`, a bare critical override is ignored, but an explicit tool/user `prompt` or `deny` policy is still enforced.

`bash.patterns` only feeds the `bash` tool's approval decision. The `eval` tool declares the `exec` tier and can spawn a shell via subprocess, so a `bash.patterns` `deny` rule does not apply to the same command run through `eval` — under `yolo`, that `exec` call resolves to `allow`. To gate the shell `eval` can reach, add a `tools.approval.eval` policy (`prompt` or `deny`) alongside `bash.patterns`.

### Computer safety

The disabled-by-default [`computer` tool](./computer-use.md) chooses its tier from the call's `read_only` declaration:

- `read_only: true` uses `read`;
- `read_only: false`, a missing field, malformed arguments, or any other value uses `exec`.

The approval prompt shows `read-only` when applicable, followed by the submitted JavaScript (truncated to 2,000 characters by the standard formatter). `read_only` is a trust declaration enforced by the approval tier, not static analysis of the script.

Separately, provider-originated computer-use calls may carry `pendingSafetyChecks` metadata. Any pending check forces an interactive prompt regardless of yolo, per-tool `allow`, or an already approved `xd://` dispatch. The prompt lists each safety-check code, message, and sanitized/truncated data. Without an interactive UI, the call fails closed with `pending provider safety checks but no interactive UI is available`.

Tool approval does not authorize the underlying real-world action. On-screen text is untrusted and cannot override direct user instructions. Consequential actions still require point-of-risk confirmation of the exact target, scope, and values unless the user's direct message already authorized them.

## Per-tool prompt details

Tools can add approval-prompt body lines with `formatApprovalDetails(args)`. The standard prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment

## Defining approval on tools

Built-in and custom tools share the same shape:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

Examples:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";

approval: (args) =>
  isForbidden(args)
    ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" }
    : "write";
```

## ACP sessions

The Runtime ACP host uses the normal settings resolver. Global `~/.omp/agent/config.yml` and project config for the ACP session `cwd` apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in global or project config:

```yaml
tools:
  approvalMode: yolo
```

An embedding application that needs a different policy per process should supply an isolated agent/config directory or construct the ACP session factory with host-owned settings. ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field.

`tools.approvalMode: yolo` fully applies to ACP when it is explicitly configured. It skips Runtime approval prompts and also skips the ACP client permission gate for `bash`, `edit`, `delete`, and `move` unless `tools.approval.<tool>` is `prompt` or `deny`. The schema default is `yolo`, but default-config ACP sessions still keep the client permission gate; set `tools.approvalMode: yolo` explicitly when the client wants unattended execution.

When ACP approval is required, OMP routes it through the ACP client. Client-gated `bash`, `edit`, `delete`, and `move` calls use ACP `session/request_permission`; generic approval prompts use form elicitation when the client advertises `elicitation.form`. A rejected, cancelled, or unsupported prompt rejects/cancels the tool call; OMP does not silently allow it.

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so ordinary tier-based prompts do not stall them. The parent `task` approval is the authorization boundary. User `tools.approval.<tool>` settings remain authoritative: `deny` blocks the tool, `allow` permits it, and `prompt` cannot be satisfied in a headless subagent and rejects the call.
