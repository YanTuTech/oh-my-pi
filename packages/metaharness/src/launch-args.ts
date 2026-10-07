/**
 * Shared launch surface: the POST /api/runs request shape and its mapping to
 * runner CLI argv. The server uses it to spawn new harbor runs; the runner's
 * `--resume` uses it to rebuild the original invocation from a job dir's
 * manager.json launch record when no runner-config.json snapshot exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateModelEndpoint } from "../adapters/mcp/agent-protocol";
import { parseTimeoutPolicy, type TimeoutPolicy } from "../adapters/mcp/agent-scheduling";
import { type AgentSuite, parseAgentSuite } from "../adapters/mcp/agent-suites";
import type { HarnessSourceRequest } from "./harness-source";
import type { BenchmarkKind, HarnessVariant, RunRole } from "./store";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export interface McpLaunchOptions {
	mode?: "agent" | "deterministic";
	suite?: AgentSuite;
	policy?: "correct" | "overcall" | "misselection";
	baseUrl?: string;
	apiKeyEnv?: string;
	timeoutMs?: number;
	maxRequests?: number;
	maxToolCalls?: number;
	maxOutputTokens?: number;
	temperature?: number;
	budgetUsd?: number;
	timeoutPolicy?: TimeoutPolicy;
}

/** POST /api/runs body. Mirrors the runner CLI surface we actually use. */
export interface LaunchRequest {
	/** Benchmark adapter to execute. */
	benchmark?: BenchmarkKind;
	model: string;
	dataset?: string;
	/** Task count for a dataset sample, or omit when `include` is given. */
	tasks?: number;
	/** Explicit task names (passed as repeated --include). */
	include?: string[];
	concurrency?: number;
	/** SnapCompact conditions; ignored by other benchmarks. */
	conditions?: string[];
	timeoutMultiplier?: number;
	attempts?: number;
	agent?: string;
	jobName?: string;
	webSearch?: boolean;
	/** Harbor container backend. Defaults to apple-container whenever the Apple `container` CLI is installed; docker is an explicit opt-in. */
	environment?: "docker" | "apple-container";
	/** Prewalk to a fast/cheap model at the first edit/write once the todo list exists; `into` overrides the default "smol" target. */
	prewalk?: { into?: string };
	/** Role of this run inside its experiment (baseline vs treatment). */
	role?: RunRole;
	/** One-line description of what this arm tests. */
	note?: string;
	/**
	 * Which harness layer(s) this arm varies. Attribution only — it does not
	 * change how the run executes, it makes the arm attributable to a layer so a
	 * comparison can answer "which layer got better?".
	 */
	harness?: HarnessVariant;
	/** Execution binding, distinct from caller-supplied attribution labels. MCP agent mode only. */
	harnessSource?: HarnessSourceRequest;
	mcp?: McpLaunchOptions;
	/** Experiment goal; upserted for the run's experiment (job-name prefix). */
	goal?: string;
	/** Use prebuilt dist/omp-linux-* binaries instead of the default source mount. */
	prebuiltBinaries?: boolean;
	/** Extra raw runner args, appended verbatim. */
	extraArgs?: string[];
}

/** Validated MCP launch mapping. Reserved execution flags cannot be overridden by extraArgs. */
export function mcpRunnerArgs(request: LaunchRequest, jobDir: string): string[] {
	const options = request.mcp ?? {};
	const mode = options.mode ?? (options.policy ? "deterministic" : "agent");
	if (mode !== "agent" && mode !== "deterministic") throw new Error("Unsupported MCP mode");
	if (request.extraArgs?.length) throw new Error("MCP extraArgs are not supported; use structured mcp options");
	if (request.concurrency !== undefined && request.concurrency !== 1)
		throw new Error("MCP trial concurrency must be 1");
	if (request.agent && request.agent !== "omp") throw new Error("MCP benchmark supports only omp");
	if (options.policy && mode !== "deterministic")
		throw new Error("A deterministic policy cannot drive an agent evaluation");
	if (options.policy && !["correct", "overcall", "misselection"].includes(options.policy))
		throw new Error("Invalid MCP policy");
	if (request.harnessSource && mode !== "agent") throw new Error("Harness source binding requires MCP agent mode");
	const timeoutPolicy = parseTimeoutPolicy(options.timeoutPolicy);
	if (options.timeoutPolicy !== undefined && mode !== "agent")
		throw new Error("Timeout policy requires MCP agent mode");
	if (options.baseUrl !== undefined) validateModelEndpoint(options.baseUrl);
	if (options.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(options.apiKeyEnv))
		throw new Error("Invalid credential environment variable name");
	if (options.temperature !== undefined && options.temperature > 2) throw new Error("Temperature must be within 0..2");
	if (
		(options.timeoutMs ?? 0) > 900_000 ||
		(options.maxRequests ?? 0) > 64 ||
		(options.maxToolCalls ?? 0) > 256 ||
		(options.maxOutputTokens ?? 0) > 32_768 ||
		(request.attempts ?? 0) > 100
	)
		throw new Error("MCP request exceeds supported resource limits");
	const args = ["--mode", mode, "--model", request.model, "--output", path.join(jobDir, "result.json")];
	if (request.dataset === "mcp-challenge-v2" && options.suite === undefined)
		throw new Error("v2 dataset requires explicit mcp.suite");
	if (options.suite !== undefined) {
		if (mode !== "agent") throw new Error("Versioned suites require MCP agent mode");
		const suite = parseAgentSuite(options.suite);
		if (
			request.dataset !== undefined &&
			request.dataset !== suite &&
			!(suite === "mcp-smoke-v1" && request.dataset === "mcp-agent-v1")
		)
			throw new Error("Dataset conflicts with MCP suite");
		args.push("--suite", suite);
	}
	const numeric: [string, number | undefined][] = [
		["--max-tasks", request.tasks],
		["--runs", request.attempts],
		["--timeout-ms", options.timeoutMs],
		["--max-requests", options.maxRequests],
		["--max-tool-calls", options.maxToolCalls],
		["--max-output-tokens", options.maxOutputTokens],
	];
	for (const [flag, value] of numeric) {
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${flag}`);
		args.push(flag, String(value));
	}
	if (request.include?.length) args.push("--tasks", request.include.join(","));
	if (options.policy) args.push("--policy", options.policy);
	for (const [flag, value] of [
		["--base-url", options.baseUrl],
		["--api-key-env", options.apiKeyEnv],
	] as const) {
		if (value !== undefined) {
			if (typeof value !== "string" || !value) throw new Error(`Invalid ${flag}`);
			args.push(flag, value);
		}
	}
	for (const [flag, value] of [
		["--temperature", options.temperature],
		["--budget-usd", options.budgetUsd],
	] as const) {
		if (value !== undefined) {
			if (!Number.isFinite(value) || value < 0 || (flag === "--budget-usd" && value === 0))
				throw new Error(`Invalid ${flag}`);
			args.push(flag, String(value));
		}
	}
	if (timeoutPolicy.mode === "continue")
		args.push(
			"--max-timeout-failures",
			String(timeoutPolicy.maxTimeoutFailures),
			"--max-consecutive-timeouts",
			String(timeoutPolicy.maxConsecutiveTimeouts),
			"--unknown-usage-reserve-usd",
			String(timeoutPolicy.unknownUsageReserveUsd),
		);
	if (request.harnessSource) {
		const source = request.harnessSource;
		if (typeof source.root !== "string" || !source.root.trim()) throw new Error("Invalid harness source root");
		args.push("--harness-source", source.root);
		if (source.expectedSourceDigest !== undefined) {
			if (!/^[a-f0-9]{64}$/.test(source.expectedSourceDigest)) throw new Error("Invalid expected source digest");
			args.push("--expected-source-digest", source.expectedSourceDigest);
		}
		if (source.expectedBaseCommit !== undefined) {
			if (!/^[a-f0-9]{40,64}$/.test(source.expectedBaseCommit)) throw new Error("Invalid expected base commit");
			args.push("--expected-base-commit", source.expectedBaseCommit);
		}
	}
	return args;
}

/** Runner CLI flags (sans the `bun src/runner.ts` prefix) for a harbor launch. */
export function harborRunnerArgs(
	request: LaunchRequest,
	opts: { jobsDir: string; jobName: string; dataset: string },
): string[] {
	const argv = ["--model", request.model, "-d", opts.dataset, "--job-name", opts.jobName, "--jobs-dir", opts.jobsDir];
	// Prefer Apple Container when its CLI is present: native arm64 task
	// containers with no Docker daemon. The runner itself defaults to
	// docker, so the preference must be stated here.
	const environment = request.environment ?? (Bun.which("container") ? "apple-container" : "docker");
	argv.push("--environment", environment);
	if (request.agent) argv.push("--agent", request.agent);
	// An explicit include list IS the sample — never let the runner's
	// default task cap truncate it.
	const tasks = request.tasks ?? (request.include && request.include.length > 0 ? request.include.length : undefined);
	if (tasks !== undefined) argv.push("--tasks", String(tasks));
	if (request.concurrency !== undefined) argv.push("--concurrency", String(request.concurrency));
	if (request.attempts !== undefined) argv.push("--attempts", String(request.attempts));
	if (request.timeoutMultiplier !== undefined) argv.push("--timeout-multiplier", String(request.timeoutMultiplier));
	if (request.webSearch) argv.push("--web-search");
	for (const task of request.include ?? []) argv.push("--include", task);
	if (request.prewalk) {
		argv.push("--agent-arg", "--prewalk");
		if (request.prewalk.into) {
			argv.push("--agent-arg", "--prewalk-into", "--agent-arg", request.prewalk.into);
			const provider = request.prewalk.into.split("/", 1)[0];
			if (provider && request.prewalk.into.includes("/")) argv.push("--providers", provider);
		}
	}
	if (request.prebuiltBinaries) {
		for (const name of ["omp-linux-arm64", "omp-linux-x64"]) {
			const binary = path.join(REPO_ROOT, "packages", "coding-agent", "dist", name);
			if (fs.existsSync(binary)) argv.push("--binary", binary);
		}
	}
	argv.push(...(request.extraArgs ?? []));
	return argv;
}
