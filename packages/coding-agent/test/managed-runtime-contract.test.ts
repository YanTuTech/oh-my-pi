import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { canonicalRpcHostToolArguments, createRpcHostToolManifestDigest } from "../src/modes/rpc/host-tools";
import { createManagedModelBrokerStreamFn } from "../src/modes/rpc/managed-model-broker";
import { isManagedRuntimeCommandAllowed } from "../src/modes/rpc/managed-runtime";
import {
	buildManagedRuntimeEnvironment,
	defineRpcClientTool,
	isExactManagedHostToolAcknowledgement,
	isManagedRuntimeReadyFrame,
	RpcClient,
	validateManagedRuntimeClientLaunch,
} from "../src/modes/rpc/rpc-client";
import { parseRuntimeRpcArgs } from "../src/runtime-rpc-args";

const digest = (character: string): string => character.repeat(64);
const launchBinding = {
	contractVersion: 1 as const,
	protocolEpoch: 1 as const,
	runtimeBundleDigest: digest("a"),
	buildGraphDigest: digest("b"),
	capabilityRegistryDigest: createRpcHostToolManifestDigest([]),
	launchTicketDigest: digest("d"),
	channelBindingDigest: digest("e"),
	workerGeneration: 3,
	policyGeneration: 7,
};

describe("managed Runtime contract", () => {
	test("routes model inference only through the launcher-selected Unix socket", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-model-broker-"));
		const socketPath = path.join(directory, "model.sock");
		let requestPath: string | undefined;
		let authorization: string | null = null;
		const server = Bun.serve({
			unix: socketPath,
			fetch(request) {
				requestPath = new URL(request.url).pathname;
				authorization = request.headers.get("authorization");
				const usage = {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				const body = [
					{ type: "start" },
					{ type: "text_start", contentIndex: 0 },
					{ type: "text_delta", contentIndex: 0, delta: "brokered" },
					{ type: "text_end", contentIndex: 0 },
					{ type: "done", reason: "stop", usage },
				]
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join("");
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const model: Model = buildModel({
			id: "managed-model",
			name: "Managed Model",
			api: "openai",
			provider: "managed",
			baseUrl: "https://must-not-be-contacted.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		try {
			const result = await createManagedModelBrokerStreamFn(socketPath)(model, context, {}).result();
			expect(result.content).toEqual([{ type: "text", text: "brokered" }]);
			expect(requestPath).toBe("/api/stream");
			expect(authorization).toBe("Bearer unix-peer-v1");
		} finally {
			server.stop(true);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("keeps native execution, dynamic discovery, host URI, session switching, and login outside the RPC surface", () => {
		expect(isManagedRuntimeCommandAllowed("bash")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("refresh_skills")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("set_host_uri_schemes")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("new_session")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("login")).toBe(false);
	});

	test("retains host-mediated prompting, cancellation, state, and immutable host-tool setup", () => {
		expect(isManagedRuntimeCommandAllowed("prompt")).toBe(true);
		expect(isManagedRuntimeCommandAllowed("abort")).toBe(true);
		expect(isManagedRuntimeCommandAllowed("get_state")).toBe(true);
		expect(isManagedRuntimeCommandAllowed("set_host_tools")).toBe(true);
		expect(isManagedRuntimeCommandAllowed("set_model")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("get_available_models")).toBe(false);
		expect(isManagedRuntimeCommandAllowed("set_auto_retry")).toBe(false);
	});

	test("requires an explicit managed Runtime attestation before a managed client accepts readiness", () => {
		const attestation = {
			...launchBinding,
			processId: 42,
			nativeTools: false as const,
			hostToolsMutable: false as const,
			ambientDiscovery: false as const,
			modelTransport: "unix-domain-socket" as const,
		};
		expect(
			isManagedRuntimeReadyFrame(
				{
					type: "ready",
					managedRuntime: attestation,
				},
				launchBinding,
				42,
			),
		).toBe(true);
		expect(isManagedRuntimeReadyFrame({ type: "ready" })).toBe(false);
		expect(
			isManagedRuntimeReadyFrame(
				{
					type: "ready",
					managedRuntime: { ...attestation, workerGeneration: 2 },
				},
				launchBinding,
				42,
			),
		).toBe(false);
	});

	test("requires absolute launch identities and an explicit sanitized environment", () => {
		expect(() => validateManagedRuntimeClientLaunch({ managedRuntime: true }, "/runtime/host.ts")).toThrow(
			"absolute Runtime executable path",
		);
		expect(() =>
			validateManagedRuntimeClientLaunch(
				{
					managedRuntime: true,
					runtimeExecutable: "/runtime/bun",
					cwd: "/session/data/process",
					sessionDir: "/session/data",
					provider: "openai",
					model: "gpt-managed",
					managedModelBrokerSocket: "/launcher/ipc/model.sock",
					managedRuntimeLaunchBinding: launchBinding,
				},
				"/runtime/host.ts",
			),
		).toThrow("explicit sanitized environment");
		expect(
			validateManagedRuntimeClientLaunch(
				{
					managedRuntime: true,
					runtimeExecutable: "/runtime/bun",
					cwd: "/session/data/process",
					sessionDir: "/session/data",
					env: { HOME: "/session/data/home", TMPDIR: "/session/data/tmp" },
					provider: "openai",
					model: "gpt-managed",
					managedModelBrokerSocket: "/launcher/ipc/model.sock",
					managedRuntimeLaunchBinding: launchBinding,
				},
				"/runtime/host.ts",
			),
		).toBe("/runtime/bun");
		expect(() =>
			validateManagedRuntimeClientLaunch(
				{
					managedRuntime: true,
					runtimeExecutable: "/runtime/bun",
					cwd: "/session/data/process",
					sessionDir: "/session/data",
					env: { HOME: "/session/data/home", TMPDIR: "/session/data/tmp" },
					provider: "openai",
					model: "gpt-managed",
					managedModelBrokerSocket: "/session/data/rebindable.sock",
					managedRuntimeLaunchBinding: launchBinding,
				},
				"/runtime/host.ts",
			),
		).toThrow("outside the OMP-writable session directory");
	});

	test("binds every effective host-tool manifest field into the registry digest", () => {
		const base = {
			name: "read_capability",
			label: "Read capability",
			description: "Read one approved path",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			hidden: false,
			loadMode: "discoverable" as const,
			capabilityKind: "fs.read_regular" as const,
			dispatchId: "fs.read_regular.v1",
		};
		const baseline = createRpcHostToolManifestDigest([base]);
		const mutations = [
			{ ...base, name: "read_capability_v2" },
			{ ...base, label: "Read exact path" },
			{ ...base, description: "Read a different approved path" },
			{ ...base, parameters: { type: "object", properties: { inode: { type: "number" } } } },
			{ ...base, hidden: true },
			{ ...base, loadMode: "essential" as const },
			{ ...base, capabilityKind: "fs.list" as const },
			{ ...base, dispatchId: "fs.read_regular.v2" },
		];
		for (const mutation of mutations) {
			expect(createRpcHostToolManifestDigest([mutation])).not.toBe(baseline);
		}
	});

	test("uses bounded exact JSON and locale-independent key ordering for capability arguments", () => {
		const decomposedAccent = "e\u0301";
		expect(canonicalRpcHostToolArguments({ "😀": 5, 中: 3, é: 1, [decomposedAccent]: 2, a: 4 })).toBe(
			'{"a":4,"é":2,"é":1,"中":3,"😀":5}',
		);
		expect(() => canonicalRpcHostToolArguments({ value: Number.NaN })).toThrow("must be finite");
		expect(() => canonicalRpcHostToolArguments({ value: undefined })).toThrow("not representable");
		const sparse: unknown[] = [];
		sparse.length = 1;
		expect(() => canonicalRpcHostToolArguments({ sparse })).toThrow("must not be sparse");
		const accessor = [1];
		Object.defineProperty(accessor, "0", { enumerable: true, get: () => 7 });
		expect(() => canonicalRpcHostToolArguments({ accessor })).toThrow("enumerable data indices");
		const extra = [1] as number[] & { extra?: number };
		extra.extra = 2;
		expect(() => canonicalRpcHostToolArguments({ extra })).toThrow("extra properties");
		const symbolProperty = [1];
		Object.defineProperty(symbolProperty, Symbol("extra"), { value: 2 });
		expect(() => canonicalRpcHostToolArguments({ symbolProperty })).toThrow("extra properties");
		const nonEnumerable = [1];
		Object.defineProperty(nonEnumerable, "0", { value: 1, enumerable: false });
		expect(() => canonicalRpcHostToolArguments({ nonEnumerable })).toThrow("enumerable data indices");
		expect(() => canonicalRpcHostToolArguments({ value: "x".repeat(32_769) })).toThrow("string limit");
	});

	test("accepts only an exact duplicate-free managed tool-name acknowledgement", () => {
		expect(isExactManagedHostToolAcknowledgement(["a", "b"], ["b", "a"])).toBe(true);
		expect(isExactManagedHostToolAcknowledgement(["a", "b"], ["a"])).toBe(false);
		expect(isExactManagedHostToolAcknowledgement(["a", "b"], ["a", "b", "c"])).toBe(false);
		expect(isExactManagedHostToolAcknowledgement(["a", "b"], ["a", "a"])).toBe(false);
		expect(isExactManagedHostToolAcknowledgement(["a", "b"], ["a", 2])).toBe(false);
	});

	test("builds a fixed managed environment and rejects provider credential injection", () => {
		const base = {
			managedRuntime: true,
			sessionDir: "/session/data",
			managedModelBrokerSocket: "/launcher/ipc/model.sock",
			managedRuntimeLaunchBinding: launchBinding,
		};
		expect(
			buildManagedRuntimeEnvironment({
				...base,
				env: { HOME: "/session/data/home", TMPDIR: "/session/data/tmp", LANG: "en_US.UTF-8" },
			}),
		).toEqual({
			HOME: "/session/data/home",
			TMPDIR: "/session/data/tmp",
			LANG: "en_US.UTF-8",
			OMP_MANAGED_MODEL_BROKER_SOCKET: "/launcher/ipc/model.sock",
			OMP_MANAGED_RUNTIME_BUNDLE_DIGEST: launchBinding.runtimeBundleDigest,
			OMP_MANAGED_BUILD_GRAPH_DIGEST: launchBinding.buildGraphDigest,
			OMP_MANAGED_CAPABILITY_REGISTRY_DIGEST: launchBinding.capabilityRegistryDigest,
			OMP_MANAGED_LAUNCH_TICKET_DIGEST: launchBinding.launchTicketDigest,
			OMP_MANAGED_CHANNEL_BINDING_DIGEST: launchBinding.channelBindingDigest,
			OMP_MANAGED_WORKER_GENERATION: "3",
			OMP_MANAGED_POLICY_GENERATION: "7",
		});
		expect(() =>
			buildManagedRuntimeEnvironment({
				...base,
				env: {
					HOME: "/session/data/home",
					TMPDIR: "/session/data/tmp",
					OPENAI_API_KEY: "must-not-cross",
				},
			}),
		).toThrow("environment variable is not allowed: OPENAI_API_KEY");
	});

	test("locks the host-tool manifest after managed startup, including an empty manifest", async () => {
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-runtime-contract-"));
		const brokerSocket = `${sessionDir}.model.sock`;
		const client = new RpcClient({
			managedRuntime: true,
			runtimeExecutable: process.execPath,
			rpcHostPath: path.join(import.meta.dir, "fixtures/mock-rpc-agent.ts"),
			cwd: sessionDir,
			sessionDir,
			env: {
				HOME: sessionDir,
				TMPDIR: sessionDir,
			},
			provider: "openai",
			model: "gpt-managed",
			managedModelBrokerSocket: brokerSocket,
			managedRuntimeLaunchBinding: launchBinding,
			customTools: [],
		});
		try {
			await client.start();
			await expect(
				client.setCustomTools([
					{
						name: "late_tool",
						description: "Must not enter an already attested managed tool set",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						capabilityKind: "host.control",
						dispatchId: "host.control.late.v1",
						execute: () => "unreachable",
					},
				]),
			).rejects.toThrow("immutable after initial configuration");
		} finally {
			client.stop();
			await fs.rm(sessionDir, { recursive: true, force: true });
		}
	});

	test("does not dispatch a managed host call before the exact-manifest ACK", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-host-tool-arm-"));
		const scriptPath = path.join(directory, "mock-managed-rpc.ts");
		const brokerSocket = `${directory}.model.sock`;
		const tool = defineRpcClientTool({
			name: "managed_echo",
			description: "Echo only after the managed manifest is armed",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			capabilityKind: "host.control",
			dispatchId: "host.control.echo.v1",
			execute: () => "executed",
		});
		const binding = {
			...launchBinding,
			capabilityRegistryDigest: createRpcHostToolManifestDigest([tool]),
		};
		await Bun.write(
			scriptPath,
			`const attestation = {
 contractVersion: 1, protocolEpoch: 1,
 runtimeBundleDigest: Bun.env.OMP_MANAGED_RUNTIME_BUNDLE_DIGEST,
 buildGraphDigest: Bun.env.OMP_MANAGED_BUILD_GRAPH_DIGEST,
 capabilityRegistryDigest: Bun.env.OMP_MANAGED_CAPABILITY_REGISTRY_DIGEST,
 launchTicketDigest: Bun.env.OMP_MANAGED_LAUNCH_TICKET_DIGEST,
 channelBindingDigest: Bun.env.OMP_MANAGED_CHANNEL_BINDING_DIGEST,
 workerGeneration: Number(Bun.env.OMP_MANAGED_WORKER_GENERATION),
 policyGeneration: Number(Bun.env.OMP_MANAGED_POLICY_GENERATION),
 processId: process.pid, nativeTools: false, hostToolsMutable: false,
 ambientDiscovery: false, modelTransport: "unix-domain-socket"
};
const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
write({ type: "ready", managedRuntime: attestation });
for await (const raw of console) {
 const frame = JSON.parse(raw);
 if (frame.type === "set_host_tools") {
  write({ type: "host_tool_call", id: "premature", toolCallId: "toolu_pre", toolName: "managed_echo", capabilityKind: "host.control", dispatchId: "host.control.echo.v1", arguments: {}, argumentsDigest: Bun.SHA256.hash("{}", "hex") });
  await Bun.sleep(20);
  write({ id: frame.id, type: "response", command: frame.type, success: true, data: { toolNames: ["managed_echo"], capabilityRegistryDigest: Bun.env.OMP_MANAGED_CAPABILITY_REGISTRY_DIGEST } });
 } else if (frame.type === "prompt") {
  write({ id: frame.id, type: "response", command: frame.type, success: true });
  write({ type: "agent_start" });
  write({ type: "host_tool_call", id: "armed", toolCallId: "toolu_armed", toolName: "managed_echo", capabilityKind: "host.control", dispatchId: "host.control.echo.v1", arguments: {}, argumentsDigest: Bun.SHA256.hash("{}", "hex") });
 } else if (frame.type === "host_tool_result" && frame.id === "armed") {
  write({ type: "agent_end", messages: [] });
 }
}`,
		);
		let executions = 0;
		tool.execute = () => {
			executions++;
			return "executed";
		};
		const client = new RpcClient({
			managedRuntime: true,
			runtimeExecutable: process.execPath,
			rpcHostPath: scriptPath,
			cwd: directory,
			sessionDir: directory,
			env: { HOME: directory, TMPDIR: directory },
			provider: "openai",
			model: "gpt-managed",
			managedModelBrokerSocket: brokerSocket,
			managedRuntimeLaunchBinding: binding,
			customTools: [tool],
		});
		try {
			await client.start();
			expect(executions).toBe(0);
			await client.promptAndWait("invoke after ACK");
			expect(executions).toBe(1);
		} finally {
			await client.stop();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects managed host tools without a Host-owned capability classification", async () => {
		const client = new RpcClient({ managedRuntime: true });
		await expect(
			client.setCustomTools([
				{
					name: "unclassified",
					description: "Missing authoritative manifest metadata",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					execute: () => "unreachable",
				},
			]),
		).rejects.toThrow("require ASCII names");
	});

	test("rejects a classified tool manifest that differs from the LaunchGuard registry", async () => {
		const client = new RpcClient({
			managedRuntime: true,
			managedRuntimeLaunchBinding: launchBinding,
		});
		await expect(
			client.setCustomTools([
				{
					name: "unexpected",
					description: "Not present in the signed empty registry",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					capabilityKind: "host.control",
					dispatchId: "host.control.unexpected.v1",
					execute: () => "unreachable",
				},
			]),
		).rejects.toThrow("do not match the LaunchGuard registry digest");
	});

	test("rejects launch flags that would reintroduce ambient tools, extensions, or approval", () => {
		expect(() => parseRuntimeRpcArgs(["--managed", "--tools", "read"])).toThrow(
			"--managed cannot be combined with --tools or --no-tools",
		);
		expect(() => parseRuntimeRpcArgs(["--managed", "--extension", "/tmp/plugin.ts"])).toThrow(
			"--managed cannot be combined with --extension",
		);
		expect(() => parseRuntimeRpcArgs(["--managed", "--auto-approve"])).toThrow(
			"--managed cannot be combined with --auto-approve",
		);
	});
});
