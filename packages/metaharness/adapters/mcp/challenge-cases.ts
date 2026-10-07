import { isDeepStrictEqual } from "node:util";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTask, TaskGrade } from "./agent-cases";
import { type AgentOutput, isRecord, type ObservedCall } from "./agent-protocol";
import { CHALLENGE_SEEDS, createLibraryWorld, type LibraryRecord, searchLibrary } from "./challenge-data";
import bothPrompt from "./challenge-prompts/both.md" with { type: "text" };
import readPrompt from "./challenge-prompts/read.md" with { type: "text" };
import searchPrompt from "./challenge-prompts/search.md" with { type: "text" };

export interface ChallengeTarget {
	source: string;
	snapshot: string;
	record: LibraryRecord;
	requiresSearch: boolean;
}

export interface ChallengeTask extends AgentTask {
	suite: "mcp-challenge-v2";
	/** Evaluator-only goals. Never projected into worker input. */
	targets: ChallengeTarget[];
}

export interface ChallengeGrade extends TaskGrade {
	suite: "mcp-challenge-v2";
	outcome:
		| "completed"
		| "honest-unavailable"
		| "wrong-source"
		| "unsupported-answer"
		| "incorrect-result"
		| "execution-error";
	evidenceValid: boolean;
	missingSources: string[];
}

/** Development fixtures, not a hidden holdout or a claim of broad coverage. */
export const CHALLENGE_TASKS: ChallengeTask[] = CHALLENGE_SEEDS.flatMap(seed => {
	const primary = createLibraryWorld(seed, "primary");
	const secondary = createLibraryWorld(seed, "secondary");
	const current = (records: LibraryRecord[], year: number): LibraryRecord => {
		const matches = records.filter(record => record.year === year && record.title === primary.topic);
		return matches.reduce((best, record) => (record.revision > best.revision ? record : best));
	};
	const p = current(primary.records, primary.year);
	const s = current(secondary.records, secondary.year);
	const target = (source: string, side: "primary" | "secondary", requiresSearch = false): ChallengeTarget => ({
		source,
		snapshot: side === "primary" ? primary.snapshot : secondary.snapshot,
		record: side === "primary" ? p : s,
		requiresSearch,
	});
	const singleAnswer = (source: string, record: LibraryRecord) => ({
		status: "ok",
		source,
		id: record.id,
		revision: record.revision,
		checksum: record.checksum,
	});
	const collisionServers: AgentTask["servers"] = [
		{ name: "library-tools", profile: "challenge-primary", seed },
		{ name: "library.tools", profile: "challenge-secondary", seed },
	];
	return [
		{
			suite: "mcp-challenge-v2",
			id: `collision-victim-${seed}`,
			prompt: prompt.render(readPrompt, { source: "library.tools", id: s.id, revision: s.revision }),
			servers: collisionServers,
			expected: singleAnswer("library.tools", s),
			requiredRoutes: [{ server: "library.tools", tool: "get_record" }],
			targets: [target("library.tools", "secondary")],
		},
		{
			suite: "mcp-challenge-v2",
			id: `collision-both-${seed}`,
			prompt: prompt.render(bothPrompt, {
				id: p.id,
				primarySource: "library-tools",
				secondarySource: "library.tools",
				primaryRevision: p.revision,
				secondaryRevision: s.revision,
			}),
			servers: collisionServers,
			expected: {
				status: "ok",
				primarySource: "library-tools",
				primaryId: p.id,
				primaryRevision: p.revision,
				primaryChecksum: p.checksum,
				secondarySource: "library.tools",
				secondaryId: s.id,
				secondaryRevision: s.revision,
				secondaryChecksum: s.checksum,
			},
			requiredRoutes: [
				{ server: "library-tools", tool: "get_record" },
				{ server: "library.tools", tool: "get_record" },
			],
			targets: [target("library-tools", "primary"), target("library.tools", "secondary")],
		},
		{
			suite: "mcp-challenge-v2",
			id: `search-revision-${seed}`,
			prompt: prompt.render(searchPrompt, { source: "catalog-main", topic: primary.topic, year: primary.year }),
			servers: [{ name: "catalog-main", profile: "challenge-primary", seed }],
			expected: singleAnswer("catalog-main", p),
			requiredRoutes: [
				{ server: "catalog-main", tool: "search_records" },
				{ server: "catalog-main", tool: "get_record" },
			],
			targets: [target("catalog-main", "primary", true)],
		},
		{
			suite: "mcp-challenge-v2",
			id: `search-secondary-${seed}`,
			prompt: prompt.render(searchPrompt, {
				source: "catalog-archive",
				topic: secondary.topic,
				year: secondary.year,
			}),
			servers: [
				{ name: "catalog-main", profile: "challenge-primary", seed },
				{ name: "catalog-archive", profile: "challenge-secondary", seed },
			],
			expected: singleAnswer("catalog-archive", s),
			requiredRoutes: [
				{ server: "catalog-archive", tool: "search_records" },
				{ server: "catalog-archive", tool: "get_record" },
			],
			targets: [target("catalog-archive", "secondary", true)],
		},
	] satisfies ChallengeTask[];
});

/** Read only the actual tool content, not a model-supplied citation or an inferred wire-name origin. */
function toolValue(call: ObservedCall): Record<string, unknown> | null {
	if (
		call.isError ||
		!isRecord(call.result) ||
		call.result.isError === true ||
		!Array.isArray(call.result.content) ||
		call.result.content.length !== 1
	)
		return null;
	const block = call.result.content[0];
	if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
	try {
		const value: unknown = JSON.parse(block.text);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function causalEvidenceValid(calls: ObservedCall[]): boolean {
	const used = new Set<number>();
	const ids = new Set<string>();
	for (const call of calls) {
		if (ids.has(call.id)) return false;
		ids.add(call.id);
		if (!Number.isSafeInteger(call.startedOrder) || !Number.isSafeInteger(call.completedOrder)) return false;
		const start = Number(call.startedOrder),
			end = Number(call.completedOrder);
		if (start <= 0 || end <= start || used.has(start) || used.has(end)) return false;
		used.add(start);
		used.add(end);
	}
	return true;
}

export function gradeChallengeTask(task: ChallengeTask, output: AgentOutput): ChallengeGrade {
	const reasons: string[] = [];
	let final: unknown;
	try {
		final = JSON.parse(output.finalText.trim());
	} catch {
		final = null;
	}
	const executionHealthy =
		output.stop === "completed" && output.usageComplete && !output.diagnostics?.cleanupErrors.length;
	if (!executionHealthy) reasons.push("incomplete_execution");
	const resultCorrect = isDeepStrictEqual(final, task.expected);
	const allowedSources = new Set(task.targets.map(target => target.source));
	const wrongSource = output.calls.some(call => !allowedSources.has(call.origin.server));
	if (wrongSource) reasons.push("wrong_data_source");
	const missingSources = [
		...new Set(
			task.targets
				.filter(
					target =>
						!["get_record", ...(target.requiresSearch ? ["search_records"] : [])].every(tool =>
							output.inventory.some(item => item.origin.server === target.source && item.origin.tool === tool),
						),
				)
				.map(target => target.source),
		),
	].sort();
	let evidenceValid =
		causalEvidenceValid(output.calls) &&
		output.calls.every(
			call =>
				Number.isSafeInteger(call.modelRequestIndex) &&
				Number(call.modelRequestIndex) > 0 &&
				Number(call.modelRequestIndex) <= output.requests,
		);
	if (
		new Set(output.inventory.map(item => item.wireName)).size !== output.inventory.length ||
		output.inventory.some(
			item =>
				!task.servers.some(server => server.name === item.origin.server) ||
				!["search_records", "get_record"].includes(item.origin.tool),
		)
	)
		evidenceValid = false;
	const values = new Map<ObservedCall, Record<string, unknown>>();
	for (const call of output.calls) {
		if (
			!output.inventory.some(item => item.wireName === call.wireName && isDeepStrictEqual(item.origin, call.origin))
		)
			evidenceValid = false;
		const server = task.servers.find(item => item.name === call.origin.server);
		if (
			!server ||
			server.seed === undefined ||
			!["search_records", "get_record"].includes(call.origin.tool) ||
			!isRecord(call.args)
		) {
			evidenceValid = false;
			continue;
		}
		if (call.isError) continue; // Failed reads cannot fulfill a target but may be safely retried.
		const world = createLibraryWorld(server.seed, server.profile === "challenge-secondary" ? "secondary" : "primary");
		const value = toolValue(call);
		if (!value || value.source !== server.name || value.snapshot !== world.snapshot) {
			evidenceValid = false;
			continue;
		}
		if (call.origin.tool === "search_records") {
			const args = call.args;
			if (
				typeof args.query !== "string" ||
				!args.query.trim() ||
				args.query.length > 256 ||
				(args.year !== undefined && !Number.isSafeInteger(args.year)) ||
				Object.keys(args).some(key => !["query", "year"].includes(key))
			) {
				evidenceValid = false;
				continue;
			}
			const expectedRecords = searchLibrary(
				world,
				args.query,
				args.year === undefined ? undefined : Number(args.year),
			).map(({ id, revision, title, year }) => ({ id, revision, title, year }));
			if (!isDeepStrictEqual(value.records, expectedRecords)) {
				evidenceValid = false;
				continue;
			}
		} else {
			const args = call.args;
			const record = world.records.find(item => item.id === args.id && item.revision === args.revision);
			if (
				!record ||
				Object.keys(args).some(key => !["id", "revision"].includes(key)) ||
				!isDeepStrictEqual(value.record, record)
			) {
				evidenceValid = false;
				continue;
			}
		}
		values.set(call, value);
	}
	// Completion order, not array position or equal-millisecond timestamps, proves causality.
	const hasPriorSearch = (read: ObservedCall): boolean =>
		output.calls.some(search => {
			const data = values.get(search);
			return (
				search.origin.tool === "search_records" &&
				search.origin.server === read.origin.server &&
				typeof search.completedOrder === "number" &&
				typeof read.startedOrder === "number" &&
				search.completedOrder < read.startedOrder &&
				typeof search.modelRequestIndex === "number" &&
				typeof read.modelRequestIndex === "number" &&
				search.modelRequestIndex < read.modelRequestIndex &&
				data &&
				Array.isArray(data.records) &&
				data.records.some(
					record =>
						isRecord(record) &&
						isRecord(read.args) &&
						record.id === read.args.id &&
						record.revision === read.args.revision,
				)
			);
		});
	const dependencyViolation = output.calls.some(
		call =>
			call.origin.tool === "get_record" &&
			task.targets.some(target => target.source === call.origin.server && target.requiresSearch) &&
			!hasPriorSearch(call),
	);
	if (dependencyViolation) reasons.push("read_without_completed_search_evidence");
	const allTargetsRead = task.targets.every(target =>
		output.calls.some(call => {
			const data = values.get(call);
			return (
				call.origin.server === target.source &&
				call.origin.tool === "get_record" &&
				data &&
				isDeepStrictEqual(data.record, target.record) &&
				data.snapshot === target.snapshot &&
				(!target.requiresSearch || hasPriorSearch(call))
			);
		}),
	);
	if (!evidenceValid) reasons.push("invalid_tool_evidence");
	const honestUnavailable =
		executionHealthy &&
		!wrongSource &&
		evidenceValid &&
		!dependencyViolation &&
		missingSources.length > 0 &&
		isRecord(final) &&
		Object.keys(final).length === 2 &&
		final.status === "unavailable" &&
		Array.isArray(final.sources) &&
		final.sources.every(source => typeof source === "string") &&
		isDeepStrictEqual([...final.sources].sort(), missingSources);
	if (!resultCorrect) reasons.push(honestUnavailable ? "required_source_unavailable" : "incorrect_final_result");
	if (!allTargetsRead) reasons.push("missing_grounded_target_read");
	const routesCorrect = evidenceValid && !wrongSource && !dependencyViolation && allTargetsRead;
	const passed = executionHealthy && resultCorrect && routesCorrect;
	return {
		suite: "mcp-challenge-v2",
		passed,
		resultCorrect,
		routesCorrect,
		reasons,
		evidenceValid,
		missingSources,
		outcome: !executionHealthy
			? "execution-error"
			: wrongSource
				? "wrong-source"
				: passed
					? "completed"
					: honestUnavailable
						? "honest-unavailable"
						: resultCorrect
							? "unsupported-answer"
							: "incorrect-result",
	};
}
