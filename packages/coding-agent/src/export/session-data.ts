import type { AgentState } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

/** Embedded subagent session transcript keyed by slash-joined agent path. */
export interface SubSession {
	agentId: string;
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
}

/** Serializable session snapshot shared by transport and export adapters. */
export interface SessionData {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: { name: string; description: string }[];
	subSessions?: Record<string, SubSession>;
}

function sessionHeaderForSnapshot(header: SessionHeader | null): SessionHeader | null {
	if (!header) return null;
	const snapshot = { ...header };
	delete snapshot.previousSessionFiles;
	return snapshot;
}

/** Snapshot a session without any presentation-layer formatting. */
export function buildSessionData(sm: SessionManager, state?: AgentState): SessionData {
	return {
		header: sessionHeaderForSnapshot(sm.getHeader()),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(tool => ({ name: tool.name, description: tool.description })),
	};
}
