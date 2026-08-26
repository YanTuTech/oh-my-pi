import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import type { FreshSessionResult, HandoffResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession } from "../session/session-listing";
import { toggleSessionPin } from "../session/session-pins";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type { SlashCommandRuntime, SlashCommandSpec } from "./runtime-types";

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	if (verb === "thinking") return "thinking";
	return { error: `Unknown /shake mode "${verb}". Use elide, images, or thinking.` };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = ["Workspace directories:", `  ${cwd} (working directory)`, ...additional.map(d => `  ${d}`)];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
	},
	{
		name: "new",
		description: "Start a new session",
	},
	{
		name: "fresh",
		description: "Reset provider stream state without changing the local transcript",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"Wait for the current response to finish or abort it before refreshing provider state.",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
	},
	{
		name: "clear",
		description: "Clear the conversation context in place, keeping the session",
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		acpDescription: "Compact the conversation",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const runCompact = async (): Promise<void> => {
				const before = runtime.session.getContextUsage?.();
				const beforeTokens = before?.tokens;
				try {
					await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
				} catch (err) {
					// RPC `abort` and ACP `session/cancel` propagate their explicit
					// USER_INTERRUPT_LABEL through the compaction abort signal. The client
					// already saw the interrupt it sent; emitting anything here would
					// append an out-of-turn chunk. Other cancellations (including an
					// extension veto) remain visible.
					if (err instanceof CompactionCancelledError && err.cause === USER_INTERRUPT_LABEL) return;
					// Compaction precondition failures (no model, already compacted, too
					// small) and provider errors propagate as plain Errors; surface them
					// via runtime.output so they don't fail the ACP prompt turn.
					await runtime.output(`Compaction failed: ${errorMessage(err)}`);
					return;
				}
				const after = runtime.session.getContextUsage?.();
				const afterTokens = after?.tokens;
				if (beforeTokens != null && afterTokens != null) {
					const saved = beforeTokens - afterTokens;
					await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
				} else {
					await runtime.output("Compaction complete.");
				}
			};
			// Provider-backed: background-dispatch under RPC so the serialized command
			// queue stays free for `abort` (SlashCommandRuntime.runCommandInBackground).
			// ACP/TUI have no such hook and keep the inline await.
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runCompact);
				return commandConsumed();
			}
			await runCompact();
			return commandConsumed();
		},
	},
	{
		name: "shake",
		description: "Drop heavy content from context (tool results, large blocks)",
		acpDescription: "Shake heavy content out of the conversation context",
		subcommands: [
			{ name: "elide", description: "Strip tool results + large blocks (default)" },
			{ name: "images", description: "Strip image blocks" },
			{ name: "thinking", description: "Drop all thinking blocks" },
		],
		acpInputHint: "[elide|images|thinking]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
	},
	{
		name: "handoff",
		description: "Hand off session context to a new session",
		acpDescription: "Summarize the session into a handoff document and compact in place",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before handing off.", runtime);
			}
			if (runtime.session.isGeneratingHandoff) {
				return usage("Handoff generation is already in progress.", runtime);
			}
			const runHandoff = async (): Promise<void> => {
				let result: HandoffResult | undefined;
				try {
					result = await runtime.session.handoff(command.args || undefined);
				} catch (err) {
					const message = errorMessage(err);
					// A user interrupt (ACP `session/cancel`, TUI Esc) already settled the
					// owning turn: `AgentSession.abort()` forwards its reason into the
					// handoff abort controller, and `throwIfHandoffAborted` rethrows a
					// reasoned abort verbatim — so the throw arrives as
					// `USER_INTERRUPT_LABEL`, not "Handoff cancelled". Emitting anything
					// here would append an out-of-turn chunk after the client already saw
					// `stopReason: "cancelled"`, so consume silently.
					if (message === USER_INTERRUPT_LABEL) {
						return;
					}
					// `session.handoff()` normalizes an unreasoned cancellation to this
					// exact message; every other throw is a real failure (no model
					// selected, nothing to hand off, already compacted, provider error)
					// and is surfaced verbatim behind the same "<verb> failed:" prefix
					// `/compact` uses.
					if (message === "Handoff cancelled") {
						await runtime.output("Handoff cancelled.");
						return;
					}
					// Persist the real failure so it stays debuggable after the client
					// message scrolls away (same rationale as the TUI path, #7993).
					logger.error("Handoff failed", { error: message });
					await runtime.output(`Handoff failed: ${message}`);
					return;
				}
				if (!result) {
					await runtime.output("Handoff cancelled.");
					return;
				}
				// `savedPath` is deliberately not reported: `SessionHandoff` only writes
				// the document to disk when `options.autoTriggered` is set, which the
				// user-invoked path never passes.
				await runtime.output("Context handed off and compacted in place.");
			};
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runHandoff);
				return commandConsumed();
			}
			await runHandoff();
			return commandConsumed();
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
	},
	{
		name: "pin",
		description: "Pin or unpin a session at the top of the resume list",
		inlineHint: "[session id]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const sessionArg = command.args.trim();
			let sessionId: string | undefined;
			if (sessionArg) {
				const match = await resolveResumableSession(
					sessionArg,
					runtime.cwd,
					runtime.sessionManager.getSessionDir(),
					{ allowGlobalFallback: true },
				);
				if (!match) {
					return usage(`Session "${sessionArg}" not found.`, runtime);
				}
				sessionId = match.session.id;
			} else {
				sessionId = runtime.sessionManager.getSessionId();
				if (!sessionId) {
					return usage("No active session to pin.", runtime);
				}
			}
			const pinned = await toggleSessionPin(sessionId);
			await runtime.output(pinned ? "Session pinned to the top of the resume list." : "Session unpinned.");
			return commandConsumed();
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
	},
	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		inlineHint: "<work>",
		allowArgs: true,
	},
	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		inlineHint: "<complaint>",
		allowArgs: true,
	},
	{
		name: "cleanse",
		description: "Detect and fix project diagnostics with weighted parallel subagents",
		inlineHint: "[request] [--all]",
		allowArgs: true,
	},
	{
		name: "retry",
		description: "Retry the last failed agent turn",
		handle: async (_command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before retrying.", runtime);
			}
			const didRetry = await runtime.session.retry();
			if (!didRetry) {
				return usage("Nothing to retry.", runtime);
			}
			await runtime.output("Retrying the last failed turn.");
			// `AgentSession.retry()` only schedules the continuation as a
			// post-prompt task; it returns before the retried turn streams. Hosts
			// whose prompt turn owns the event subscription (ACP) must stay open
			// across that turn — `AcpAgent.prompt` installs the subscription
			// before running the command and `#finishPrompt` unsubscribes, so
			// returning early would silently swallow the entire retried turn
			// (model output and tool calls). RPC and TUI omit this hook: they
			// stream the continuation through their own session subscription, and
			// blocking their command queue here would strand a follow-up `abort`.
			await runtime.keepTurnOpenUntilIdle?.();
			// `retry()` returned true, so a real agent turn is now scheduled — RPC
			// hosts must not be told this was local-only work.
			return commandConsumed({ agentInvoked: true });
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "stats", description: "Show memory backend statistics" },
			{ name: "diagnose", description: "Run memory backend diagnostics" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
	},
	{
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
	},
	{
		name: "move",
		description: "Move the current session to a different directory",
		acpDescription: "Move the current session to a different directory",
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}`, runtime);
			}
			try {
				await runtime.settings.flush();
			} catch (err) {
				return usage(`Failed to save pending settings: ${errorMessage(err)}`, runtime);
			}
			try {
				await runtime.session.moveSession(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			await runtime.settings.reloadForCwd(resolvedPath);
			applyProviderGlobalsFromSettings(runtime.settings);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
	},
	{
		name: "add-dir",
		description: "Add a workspace directory to this session (multi-root)",
		acpDescription: "Add a workspace directory to this session",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot add a directory while streaming.", runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, "Usage: /add-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(`Not a directory: ${resolved}`, runtime);
			} catch {
				return usage(`Directory does not exist: ${resolved}`, runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(`Already in the workspace: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Added ${added}.`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		description: "Remove a workspace directory from this session",
		acpDescription: "Remove a workspace directory from this session",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot remove a directory while streaming.", runtime);
			if (!command.args) return usage("Usage: /remove-dir <path>", runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage("Cannot remove the working directory; use /move to change it.", runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(`Not a workspace directory: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Removed ${removed}.`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: "List this session's workspace directories",
		acpDescription: "List this session's workspace directories",
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: "Exit the application",
	},
];
