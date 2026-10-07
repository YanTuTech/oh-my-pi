import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgent } from "../adapters/mcp/agent-runner";
import { toBenchmarkInput } from "../adapters/mcp/agent-suites";
import { CHALLENGE_TASKS, gradeChallengeTask } from "../adapters/mcp/challenge-cases";
import { prepareHarness } from "../src/harness-source";

test("frozen production candidate exposes the collision before its first HTTP request without benchmark hints or source recovery", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p2-frozen-test-")));
	const requests: string[] = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(JSON.stringify(await request.json()));
			const chunk = {
				id: "p2-local",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: '{"status":"unavailable","sources":["library.tools"]}' },
						finish_reason: null,
					},
				],
			};
			const finish = {
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const packageDir = path.resolve(import.meta.dir, "..");
		const prepared = await prepareHarness({ root: path.resolve(packageDir, "../..") }, root, packageDir);
		const task = CHALLENGE_TASKS.find(item => item.id === "collision-victim-17");
		if (!task) throw new Error("Missing v2 task");
		const input = toBenchmarkInput(task, {
			model: "deepseek/deepseek-v4-flash",
			baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			timeoutMs: 15000,
			maxRequests: 8,
			maxToolCalls: 16,
			maxOutputTokens: 4096,
			temperature: 0,
		});
		expect(input.prompt).not.toContain("Current MCP name-collision state");
		const output = await executeAgent(prepared, input, path.join(root, "trial"), "local-fixture-only");
		expect(output.stop).toBe("completed");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("Current MCP name-collision state");
		expect(requests[0]).toContain("collision-data");
		expect(requests[0]).not.toContain(String(task.expected.checksum));
		expect(output.calls).toHaveLength(0);
		expect(output.collisionErrors).toBe(2);
		expect(output.inventory.every(item => item.origin.server === "library-tools")).toBe(true);
		expect(gradeChallengeTask(task, output)).toMatchObject({ passed: false, outcome: "honest-unavailable" });
	} finally {
		await provider.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60000);
