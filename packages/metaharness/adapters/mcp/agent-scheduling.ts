import { type AgentOutput, isRecord } from "./agent-protocol";

/** Continuing after unknown provider spend requires an explicit, bounded policy. */
export type TimeoutPolicy =
	| { mode: "stop" }
	| {
			mode: "continue";
			/** Stop when this many total timeout failures have occurred. */
			maxTimeoutFailures: number;
			/** Circuit breaker: stop after this many consecutive timeouts. */
			maxConsecutiveTimeouts: number;
			/** Scheduling allowance, NOT measured spend or a guaranteed billing ceiling. */
			unknownUsageReserveUsd: number;
	  };

export interface SchedulingControls {
	runsPerTask: number;
	budgetUsd: number;
	order: "task-major";
	timeoutPolicy: TimeoutPolicy;
}

export function parseTimeoutPolicy(value: unknown): TimeoutPolicy {
	if (value === undefined) return { mode: "stop" };
	if (!isRecord(value)) throw new Error("Invalid timeout policy");
	if (value.mode === "stop" && Object.keys(value).length === 1) return { mode: "stop" };
	const keys = ["mode", "maxTimeoutFailures", "maxConsecutiveTimeouts", "unknownUsageReserveUsd"];
	if (value.mode !== "continue" || Object.keys(value).some(key => !keys.includes(key)))
		throw new Error("Invalid timeout policy");
	for (const key of ["maxTimeoutFailures", "maxConsecutiveTimeouts"] as const) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 100)
			throw new Error(`Invalid timeout policy ${key}`);
	}
	if (Number(value.maxConsecutiveTimeouts) > Number(value.maxTimeoutFailures))
		throw new Error("Consecutive timeout limit exceeds total timeout limit");
	if (
		typeof value.unknownUsageReserveUsd !== "number" ||
		!Number.isFinite(value.unknownUsageReserveUsd) ||
		value.unknownUsageReserveUsd <= 0
	)
		throw new Error("Timeout continuation requires a positive unknown-usage reserve");
	return {
		mode: "continue",
		maxTimeoutFailures: Number(value.maxTimeoutFailures),
		maxConsecutiveTimeouts: Number(value.maxConsecutiveTimeouts),
		unknownUsageReserveUsd: value.unknownUsageReserveUsd,
	};
}

/** Called only after process exit, protocol validation and executable verification. */
export function canContinueTimeout(output: AgentOutput, policy: TimeoutPolicy): boolean {
	const diagnostics = output.diagnostics;
	if (
		policy.mode !== "continue" ||
		output.stop !== "timeout" ||
		!diagnostics ||
		diagnostics.phase !== "finished" ||
		diagnostics.timeout?.phase !== "model" ||
		diagnostics.cleanupErrors.length !== 0
	)
		return false;
	// An HTTP rejection followed by a retry/timeout must not be mislabeled as
	// an unknown network stall. Stop on auth/quota instead of hammering a provider.
	if (
		diagnostics.requests.some(
			request =>
				[401, 403, 429].includes(request.status ?? 0) ||
				request.httpAttempts?.some(attempt => [401, 403, 429].includes(attempt.status ?? 0)),
		)
	)
		return false;
	return diagnostics.requests.length > 0 && diagnostics.tools.every(tool => tool.endedMs !== null);
}

export function timeoutLimitReason(total: number, consecutive: number, policy: TimeoutPolicy): string | null {
	if (policy.mode !== "continue") return null;
	if (consecutive >= policy.maxConsecutiveTimeouts) return "consecutive-timeout-limit";
	if (total >= policy.maxTimeoutFailures) return "total-timeout-limit";
	return null;
}
