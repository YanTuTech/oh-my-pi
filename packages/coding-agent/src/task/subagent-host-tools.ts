import type { ToolSession } from "../tools";

export interface SubagentHostToolConstraints {
	readonly allowedToolNames?: readonly string[];
	readonly allowedSkillUris?: readonly string[];
}

/** The only session capability host-tool replay needs; optional on ToolSession. */
type SubagentHostToolSession = Pick<ToolSession, "refreshRpcHostTools">;

type SubagentHostToolReplay = (
	session: SubagentHostToolSession,
	constraints: SubagentHostToolConstraints,
) => Promise<void>;

let replay: SubagentHostToolReplay | undefined;

/** Register the handler that replays host tools into freshly created subagent sessions. */
export function registerSubagentHostToolReplay(handler: SubagentHostToolReplay): void {
	replay = handler;
}

/** Replay the registered host tools into the given session (no-op when none registered). */
export async function replaySubagentHostTools(
	session: SubagentHostToolSession,
	constraints: SubagentHostToolConstraints,
): Promise<void> {
	if (replay !== undefined) await replay(session, constraints);
}
