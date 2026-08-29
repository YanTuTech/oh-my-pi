import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { defineRpcClientTool, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolUpdate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempPaths.splice(0).map(async filePath => {
			try {
				await removeWithRetries(filePath);
			} catch {}
		}),
	);
});

describe("RpcHostToolBridge", () => {
	it("keeps a staged manifest unarmed until commit and permanently rejects a discarded stage", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => frames.push(frame));
		const definition = {
			name: "staged_host_tool",
			description: "Exercises atomic manifest publication",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		};
		const discarded = bridge.stageTools([definition]);
		await expect(discarded.tools[0]!.execute("toolu_discarded", {})).rejects.toThrow("is not armed");
		discarded.discard();
		await expect(discarded.tools[0]!.execute("toolu_still_discarded", {})).rejects.toThrow("is not armed");
		expect(frames).toEqual([]);

		const committed = bridge.stageTools([definition]);
		committed.commit();
		const execution = committed.tools[0]!.execute("toolu_committed", {});
		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "committed" }] },
		});
		await expect(execution).resolves.toMatchObject({ content: [{ type: "text", text: "committed" }] });
	});

	it("rejects oversized capability arguments before emitting a host frame", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => frames.push(frame));
		const [tool] = bridge.setTools([
			{
				name: "bounded_host_tool",
				description: "Exercises the capability argument resource bound",
				parameters: { type: "object", properties: { value: { type: "string" } } },
				capabilityKind: "host.control",
				dispatchId: "host.control.bounded.v1",
			},
		]);

		await expect(tool.execute("toolu_oversized", { value: "x".repeat(256 * 1024 + 1) })).rejects.toThrow(
			"Canonical JSON string limit exceeded",
		);
		expect(frames).toEqual([]);
	});

	it("intersects child host tools and rejects Skill URIs outside the locked resource set", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => frames.push(frame));
		bridge.setTools([
			{
				name: "skill_read",
				description: "Read one Skill resource",
				parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
			},
			{
				name: "web_search",
				description: "Search",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "task",
				description: "Spawn",
				parameters: { type: "object", properties: {} },
			},
		]);
		const childTools = bridge.createTools(["skill_read", "task"], {
			allowedSkillUris: ["skill://member-a"],
		});

		expect(childTools.map(tool => tool.name)).toEqual(["skill_read"]);
		await expect(childTools[0]!.execute("denied", { uri: "skill://member-b" })).rejects.toThrow(
			"outside the locked resource set",
		);
		expect(frames).toEqual([]);

		const allowed = childTools[0]!.execute("allowed", { uri: "skill://member-a/references/x.md" });
		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		await expect(allowed).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
	});

	it("forwards host tool updates and results to the pending execution", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_sum",
				label: "Host Sum",
				description: "Adds numbers in the host process",
				parameters: {
					type: "object",
					properties: {
						left: { type: "number" },
						right: { type: "number" },
					},
					required: ["left", "right"],
					additionalProperties: false,
				},
			},
		]);

		const updates: RpcHostToolUpdate["partialResult"][] = [];
		const execution = tool.execute("toolu_1", { right: 3, left: 2 }, undefined, update => {
			updates.push(update);
		});

		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}
		expect(request.argumentsDigest).toBe(Bun.SHA256.hash('{"left":2,"right":3}', "hex"));

		bridge.handleUpdate({
			type: "host_tool_update",
			id: request.id,
			partialResult: {
				content: [{ type: "text", text: "working" }],
			},
		});
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content[0]).toEqual({ type: "text", text: "working" });

		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: {
				content: [{ type: "text", text: "5" }],
			},
		});

		await expect(execution).resolves.toEqual({
			content: [{ type: "text", text: "5" }],
		});
	});

	it("emits a cancel frame when the host tool execution is aborted", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits in the host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);

		const controller = new AbortController();
		const execution = tool.execute("toolu_2", {}, controller.signal);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		controller.abort();

		expect(frames[1]).toMatchObject({
			type: "host_tool_cancel",
			targetId: request.id,
		});
		await expect(execution).rejects.toThrow('Host tool "host_wait" was aborted');
	});
});

describe("RpcClient custom tools", () => {
	it("registers host custom tools and serves tool calls over the RPC transport", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-host-tools-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
const encoder = new TextEncoder();
let buffer = "";
let promptCount = 0;

function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}

write({ type: "ready" });

process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});

function handle(frame) {
	if (frame.type === "set_host_tools") {
		write({
			id: frame.id,
			type: "response",
			command: "set_host_tools",
			success: true,
			data: { toolNames: frame.tools.map(tool => tool.name) },
		});
		return;
	}
	if (frame.type === "prompt") {
		promptCount++;
		const args = promptCount === 1 ? { message: "hello" } : { message: 5 };
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "agent_start" });
		write({
			type: "host_tool_call",
			id: "host-call-1",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			arguments: args,
			argumentsDigest: Bun.SHA256.hash(JSON.stringify(args), "hex"),
		});
		return;
	}
	if (frame.type === "host_tool_update") {
		write({
			type: "tool_execution_update",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			args: { message: "hello" },
			partialResult: frame.partialResult,
		});
		return;
	}
	if (frame.type === "host_tool_result") {
		write({
			type: "tool_execution_end",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			result: frame.result,
			isError: frame.isError === true,
		});
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		let executions = 0;
		const client = new RpcClient({
			rpcHostPath: scriptPath,
			customTools: [
				defineRpcClientTool<{ message: string }>({
					name: "echo_host",
					description: "Echo a value from the embedding host",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string" },
						},
						required: ["message"],
						additionalProperties: false,
					},
					async execute(args, context) {
						executions++;
						context.sendUpdate(`working:${args.message}`);
						return `host:${args.message}`;
					},
				}),
			],
		});

		try {
			await client.start();
			const events = await client.promptAndWait("Trigger host tool");
			const toolEnd = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);
			expect(toolEnd?.toolName).toBe("echo_host");
			expect(toolEnd?.result).toEqual({
				content: [{ type: "text", text: "host:hello" }],
			});

			const toolUpdate = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_update" }> =>
					event.type === "tool_execution_update",
			);
			expect(toolUpdate?.partialResult).toEqual({
				content: [{ type: "text", text: "working:hello" }],
			});

			const invalidEvents = await client.promptAndWait("Trigger invalid host tool arguments");
			const invalidEnd = invalidEvents.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);
			expect(invalidEnd?.isError).toBe(true);
			expect(invalidEnd?.result.content).toEqual([
				{ type: "text", text: "Host tool arguments failed schema validation" },
			]);
			expect(executions).toBe(1);
		} finally {
			await client.stop();
		}
	});
});
