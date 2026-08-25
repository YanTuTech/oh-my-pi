import { describe, expect, test } from "bun:test";
import * as runtime from "@oh-my-pi/pi-coding-agent";
import packageManifest from "../package.json" with { type: "json" };

describe("headless runtime package surface", () => {
	test("keeps the embeddable runtime and RPC APIs", () => {
		expect(runtime.createAgentSession).toBeFunction();
		expect(runtime.RpcClient).toBeFunction();
		expect(runtime.defineRpcClientTool).toBeFunction();
		expect(runtime.runRpcMode).toBeFunction();
		expect(runtime.projectRpcSessionEvent).toBeFunction();
	});

	test("does not expose terminal product entrypoints", () => {
		expect("bin" in packageManifest).toBeFalse();
		expect(packageManifest.exports["./main"]).toBeNull();
		expect(packageManifest.exports["./cli/*"]).toBeNull();
		expect(packageManifest.exports["./modes/components/*"]).toBeNull();
		expect(packageManifest.exports["./tui/*"]).toBeNull();
		expect("Container" in runtime).toBeFalse();
		expect("ExtensionEditorComponent" in runtime).toBeFalse();
	});
});
