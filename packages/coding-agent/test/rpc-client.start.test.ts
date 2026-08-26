import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-start-");
		using client = new RpcClient({
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_CODING_AGENT_DIR: tempDir.path(), PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
});
