#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseModelProfile } from "../adapters/mcp/agent-protocol";
import manifest from "../docs/P2-CANDIDATE.json" with { type: "json" };
import { prepareHarness, sha256 } from "../src/harness-source";
import { reviewChallengeResult } from "./review-mcp-challenge";

/** Verify the old evidence and rebuild the candidate, without opening any credentials or provider. */
export async function verifyP2Candidate(): Promise<void> {
	const pkg = path.resolve(import.meta.dir, ".."),
		repo = path.resolve(pkg, "../..");
	const baselinePath = path.join(pkg, manifest.baseline);
	const review = await reviewChallengeResult(baselinePath);
	if (
		review.resultSha256 !== manifest.baselineSha256 ||
		review.sourceDigest !== manifest.baselineSourceDigest ||
		review.planned !== 36 ||
		review.executed !== 36 ||
		!review.usageComplete
	)
		throw new Error("Pinned baseline evidence changed or is incomplete");
	const baseline = await Bun.file(baselinePath).json();
	const profile = parseModelProfile(
		await Bun.file(path.join(pkg, manifest.modelProfile)).json(),
		"opencode-go/deepseek-v4.1-flash",
	);
	if (
		!isDeepStrictEqual(profile, baseline.evaluation.controls.modelProfile) ||
		profile.api !== "openai-completions" ||
		profile.baseUrl !== "https://opencode.ai/zen/go/v1"
	)
		throw new Error("Go model profile no longer matches the baseline");
	for (const file of manifest.productionFiles) {
		if (sha256(await Bun.file(path.join(repo, file.path)).bytes()) !== file.sha256)
			throw new Error(`Reviewed P2 file changed: ${file.path}`);
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p2-candidate-preflight-"));
	try {
		const candidate = await prepareHarness(
			{
				root: repo,
				expectedBaseCommit: manifest.expectedBaseCommit,
				expectedSourceDigest: manifest.candidateSourceDigest,
			},
			await fs.realpath(root),
			pkg,
		);
		if (
			candidate.execution.driverDigest !== manifest.driverDigest ||
			candidate.execution.driverDigest !== baseline.execution.driverDigest ||
			candidate.execution.dependencyLockDigest !== baseline.execution.dependencyLockDigest
		)
			throw new Error("P2 changed the evaluator driver or dependencies");
		process.stdout.write(
			`${JSON.stringify({ verified: true, model: baseline.evaluation.model, suite: baseline.evaluation.suite, baseline: review.resultSha256, candidateSource: candidate.execution.sourceDigest, driverUnchanged: true, plannedCandidateTrials: 36, providerCalls: 0 }, null, 2)}\n`,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.argv.length !== 2) throw new Error("Usage: bun scripts/verify-p2-candidate.ts");
	await verifyP2Candidate();
}
