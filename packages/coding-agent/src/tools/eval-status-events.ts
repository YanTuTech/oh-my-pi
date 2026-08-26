import type { EvalStatusEvent } from "../eval/types";

export const EVAL_DEFAULT_PREVIEW_LINES = 10;

/** Coalesce agent progress snapshots by id while retaining discrete status events. */
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const id = event.id;
		const index = events.findIndex(candidate => candidate.op === "agent" && candidate.id === id);
		if (index >= 0) {
			events[index] = event;
			return;
		}
	}
	events.push(event);
}
