/**
 * Hub messaging half — agent-to-agent messaging over the process-global IrcBus.
 *
 * `send` is fire-and-forget: the bus routes the message to the recipient
 * (waking idle agents with a real turn, reviving parked ones via the
 * lifecycle manager, injecting a non-interrupting aside into busy ones) and
 * returns delivery receipts immediately. Replies are real turns by the
 * recipient, observed with `wait` (or the `await: true` send sugar). `inbox`
 * drains pending messages; `list` shows every addressable peer.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { IrcBus, type IrcMessage } from "../../irc/bus";
import { type AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { canSpawnAtDepth } from "../../task/types";
import { type CoordinationDetails, hubErrorResult } from "./types";

export const DEFAULT_IRC_TIMEOUT_MS = 120_000;

/**
 * Messaging availability: there must be someone to chat with. True for every
 * subagent (it always has a parent, and possibly siblings) and for any
 * session that can still spawn subagents through the task tool. Only a
 * top-level session with task spawning unavailable has no peers.
 */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	// Top-level session: peers exist only if it can still spawn subagents — the
	// same capacity gate the task tool uses, reused here to avoid drift.
	const maxDepth = settings.get("task.maxRecursionDepth") ?? 2;
	return canSpawnAtDepth(maxDepth, taskDepth);
}

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export function normalizeIrcTimeoutMs(value: number): number {
	if (value === 0) return 0; // 0 = timeout disabled
	// Negative or non-finite settings are misconfigurations — fall back to the
	// default instead of producing an instant 1 ms timeout.
	if (!Number.isFinite(value) || value < 0) return DEFAULT_IRC_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

/** Effective message-wait timeout: explicit param wins, then `irc.timeoutMs`. */
export function resolveMessageTimeoutMs(settings: Settings, explicit?: number): number {
	if (explicit !== undefined) return normalizeIrcTimeoutMs(explicit);
	return normalizeIrcTimeoutMs(settings.get("irc.timeoutMs"));
}

/** Session-buffered inbox drain used before parking a bus waiter. */
export function drainPendingInbox(registry: AgentRegistry, senderId: string, from?: string): IrcMessage | undefined {
	const session = registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
		: undefined;
}

/** `wait` result carrying a consumed message. */
export function messageResult(senderId: string, waited: IrcMessage): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: formatIncoming(waited) }],
		details: { op: "wait", from: senderId, waited },
	};
}

/**
 * List every addressable peer, restoring parked refs from disk when a resumed
 * session has no in-memory roster.
 */
export async function executeList(
	registry: AgentRegistry,
	senderId: string,
): Promise<AgentToolResult<CoordinationDetails>> {
	let refs = registry.list();
	if (!refs.some(ref => ref.id !== senderId && ref.status !== "aborted" && ref.kind !== "advisor")) {
		await registerPersistedSubagents(registry, registry.get(senderId)?.sessionFile);
		refs = registry.list();
	}

	const bus = IrcBus.global();
	const peers = refs
		.filter(ref => ref.id !== senderId && ref.status !== "aborted" && ref.kind !== "advisor")
		.map(ref => ({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			unread: bus.unreadCount(ref.id),
			lastActivity: ref.lastActivity,
			activity: ref.activity,
		}));
	const lines: string[] = [];
	if (peers.length === 0) {
		lines.push("No other agents.");
	} else {
		lines.push(`${peers.length} peer(s):`);
		for (const peer of peers) {
			const extras = [
				peer.activity || undefined,
				peer.unread > 0 ? `unread ${peer.unread}` : undefined,
				peer.parentId ? `parent ${peer.parentId}` : undefined,
				`active ${formatDuration(Date.now() - peer.lastActivity)} ago`,
			].filter(Boolean);
			lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}] — ${extras.join(", ")}`);
		}
		if (peers.some(peer => peer.status === "parked")) {
			lines.push("");
			lines.push("Parked agents are revived automatically when you message them.");
		}
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "list", from: senderId, peers },
	};
}

export interface HubSendParams {
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	timeoutMs?: number;
}

export async function executeSend(
	deps: { registry: AgentRegistry; senderId: string; settings: Settings },
	params: HubSendParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings } = deps;
	const to = params.to?.trim();
	const message = params.message?.trim();
	if (!to) {
		return hubErrorResult('`to` is required for op="send".', { op: "send", from: senderId });
	}
	if (!message) {
		return hubErrorResult('`message` is required for op="send".', { op: "send", from: senderId });
	}
	if (to === senderId) {
		return hubErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	}
	const isBroadcast = to === "all";
	if (isBroadcast && params.await) {
		return hubErrorResult('`await` is invalid with to:"all" — broadcasts have no single replier.', {
			op: "send",
			from: senderId,
			to,
		});
	}

	const bus = IrcBus.global();
	let waited: IrcMessage | null | undefined;
	const timeoutMs = params.await ? resolveMessageTimeoutMs(settings, params.timeoutMs) : undefined;
	const awaitAbort = params.await ? new AbortController() : undefined;
	const awaitCancelled = new Error("IRC await cancelled");
	let removeAwaitAbortListener: (() => void) | undefined;
	const waiting = params.await
		? bus
				.wait(senderId, { from: to }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, awaitAbort?.signal, {
					drainPending: false,
				})
				.then(
					message => ({ message, error: null as Error | null }),
					error => ({
						message: null,
						error: error === awaitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
					}),
				)
		: undefined;
	if (params.await && signal && awaitAbort) {
		if (signal.aborted) {
			awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
		} else {
			const onAbort = (): void => {
				awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAwaitAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	try {
		// Broadcasts fan out to live peers only (running | idle); reviving every
		// parked agent on a broadcast would be a stampede. Direct sends go
		// through the bus unfiltered so parked recipients are revived.
		const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
		// A broadcast that also reaches the main agent delivers the body to it
		// directly (its own incoming card); relaying the sibling legs to the
		// main UI would then show the same body once per other recipient.
		const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
		const receipts = await Promise.all(
			targets.map(target =>
				bus.send(
					{ from: senderId, to: target, body: message, replyTo: params.replyTo },
					// Awaited sends mark the sender as blocked on an answer so a
					// busy recipient that cannot reach a step boundary (async
					// disabled) auto-replies instead of stranding the sender.
					{ expectsReply: params.await || undefined, suppressRelay: suppressRelay || undefined },
				),
			),
		);

		const lines: string[] = [];
		const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
		if (targets.length === 0) {
			lines.push("No live peers to broadcast to.");
		} else if (delivered.length === 0) {
			lines.push("No recipients received the message.");
		} else {
			lines.push(`Delivered to ${delivered.length} peer(s):`);
		}
		for (const receipt of receipts) {
			lines.push(
				receipt.outcome === "failed"
					? `- ${receipt.to}: failed — ${receipt.error ?? "unknown error"}`
					: `- ${receipt.to}: ${receipt.outcome}`,
			);
		}

		if (params.await && waiting && timeoutMs !== undefined) {
			lines.push("");
			if (delivered.length > 0) {
				const reply = await waiting;
				if (reply.error) {
					// The send already succeeded; if the wait was interrupted by our
					// caller signal (steering / messaging), preserve the delivery receipt
					// so the agent loop keeps this tool as "sent" instead of marking it
					// skipped, which would prompt a duplicate resend on the next turn.
					if (signal?.aborted) {
						lines.push(
							`Send delivered but the reply wait was interrupted before ${to} answered. ` +
								"Check `inbox` or `wait` again after handling the interrupt.",
						);
					} else {
						throw reply.error;
					}
				} else {
					waited = reply.message;
					if (waited) {
						lines.push(`Reply from ${waited.from}:`);
						lines.push(waited.body);
					} else {
						lines.push(
							`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
								"They may answer later — check `inbox` or `wait` again.",
						);
					}
				}
			} else {
				awaitAbort?.abort(awaitCancelled);
				const reply = await waiting;
				if (reply.error) throw reply.error;
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: senderId,
				to,
				receipts,
				...(waited !== undefined ? { waited } : {}),
			},
			isError: delivered.length === 0 && targets.length > 0,
		};
	} finally {
		awaitAbort?.abort(awaitCancelled);
		removeAwaitAbortListener?.();
	}
}

/** Pure message wait: no jobs in play, block on the bus with peer liveness. */
export async function executeMessageWait(
	deps: { registry: AgentRegistry; senderId: string; settings: Settings },
	params: { from?: string; timeoutMs?: number },
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings } = deps;
	const from = params.from?.trim() || undefined;
	const timeoutMs = resolveMessageTimeoutMs(settings, params.timeoutMs);
	try {
		const waited = await IrcBus.global().wait(senderId, { from }, timeoutMs, signal, {
			liveness: { registry, senderId },
		});
		if (!waited) {
			const filterNote = from ? ` from ${from}` : "";
			return {
				content: [{ type: "text", text: `No message${filterNote} within ${formatDuration(timeoutMs)}.` }],
				details: { op: "wait", from: senderId, waited: null },
				// A clean wait timeout carries no information once consumed.
				useless: true,
			};
		}
		return messageResult(senderId, waited);
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		return hubErrorResult(error instanceof Error ? error.message : String(error), { op: "wait", from: senderId });
	}
}

export function executeInbox(
	registry: AgentRegistry,
	senderId: string,
	peek?: boolean,
): AgentToolResult<CoordinationDetails> {
	const busMessages = IrcBus.global().inbox(senderId, { peek });
	const session = registry.get(senderId)?.session;
	const pendingMessages =
		typeof session?.drainPendingIrcInboxMessages === "function" ? session.drainPendingIrcInboxMessages(senderId) : [];
	const messages = [...busMessages, ...pendingMessages].sort((a, b) => a.ts - b.ts);
	if (messages.length === 0) {
		return {
			content: [{ type: "text", text: "Inbox empty." }],
			details: { op: "inbox", from: senderId, inbox: [] },
			// An empty inbox drain carries no information once consumed.
			useless: true,
		};
	}
	const header = peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
	const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "inbox", from: senderId, inbox: messages },
	};
}
