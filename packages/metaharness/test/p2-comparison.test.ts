import { expect, test } from "bun:test";
import { assertP2Comparable, type P2ComparisonIdentity } from "../scripts/compare-p2-capability";

const baseline: P2ComparisonIdentity = {
	source: "a".repeat(64),
	driver: "b".repeat(64),
	dependencies: "c".repeat(64),
	runtimePlatform: "darwin-arm64",
	bunVersion: "1.3.14",
	suite: "mcp-challenge-v2",
	model: "opencode-go/deepseek-v4.1-flash",
	tasks: "d".repeat(64),
	fixture: "e".repeat(64),
	evaluator: "f".repeat(64),
	controls: "1".repeat(64),
	scheduling: "2".repeat(64),
};

test("P2-only comparisons reject relabeled source, alternate providers, and changed evaluators or budgets", () => {
	const candidate = { ...baseline, source: "3".repeat(64) };
	assertP2Comparable(baseline, candidate);
	expect(() => assertP2Comparable(baseline, baseline)).toThrow("did not change");
	for (const key of [
		"driver",
		"dependencies",
		"runtimePlatform",
		"bunVersion",
		"model",
		"tasks",
		"fixture",
		"evaluator",
		"controls",
		"scheduling",
	] as const) {
		expect(() => assertP2Comparable(baseline, { ...candidate, [key]: `different-${key}` })).toThrow(
			`differs in ${key}`,
		);
	}
	expect(() => assertP2Comparable(baseline, { ...candidate, suite: "mcp-smoke-v1" })).toThrow("requires v2");
});
