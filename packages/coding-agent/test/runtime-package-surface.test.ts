import { describe, expect, test } from "bun:test";
import * as runtime from "@oh-my-pi/pi-coding-agent";
import * as htmlExport from "@oh-my-pi/pi-coding-agent/export/html";
import * as embeddedRuntime from "@oh-my-pi/pi-coding-agent/runtime";
import packageManifest from "../package.json" with { type: "json" };

describe("headless runtime package surface", () => {
	test("keeps the embeddable runtime and RPC APIs", () => {
		expect(runtime.AuthStorage).toBeFunction();
		expect(runtime.ModelRegistry).toBeFunction();
		expect(runtime.SessionManager).toBeFunction();
		expect(runtime.Settings).toBeFunction();
		expect(runtime.createAgentSession).toBeFunction();
		expect(runtime.createAcpConnection).toBeFunction();
		expect(runtime.RpcClient).toBeFunction();
		expect(runtime.RpcClient.prototype.exportHtml).toBeFunction();
		expect(runtime.defineRpcClientTool).toBeFunction();
		expect(runtime.runRpcMode).toBeFunction();
		expect(runtime.projectRpcSessionEvent).toBeFunction();
	});

	test("provides an SDK-only embedding entrypoint", () => {
		expect(embeddedRuntime.AuthStorage).toBeFunction();
		expect(embeddedRuntime.ModelRegistry).toBeFunction();
		expect(embeddedRuntime.SessionManager).toBeFunction();
		expect(embeddedRuntime.Settings).toBeFunction();
		expect(embeddedRuntime.createAgentSession).toBeFunction();
		expect(embeddedRuntime.loadExtensions).toBeFunction();
		expect(embeddedRuntime.loadSkills).toBeFunction();
		expect("RpcClient" in embeddedRuntime).toBeFalse();
		expect("createAcpConnection" in embeddedRuntime).toBeFalse();
		expect("runRpcMode" in embeddedRuntime).toBeFalse();
		expect("toolRenderers" in embeddedRuntime).toBeFalse();
	});

	test("does not expose terminal product entrypoints", () => {
		expect("bin" in packageManifest).toBeFalse();
		expect(packageManifest.exports["./main"]).toBeNull();
		expect(packageManifest.exports["./cli"]).toBeNull();
		expect(packageManifest.exports["./cli/*"]).toBeNull();
		expect(packageManifest.exports["./modes/components/*"]).toBeNull();
		expect(packageManifest.exports["./tui/*"]).toBeNull();
		expect("Container" in runtime).toBeFalse();
		expect("ExtensionEditorComponent" in runtime).toBeFalse();
		expect("toolRenderers" in runtime).toBeFalse();
		expect("renderDefaultToolExecution" in runtime).toBeFalse();
	});

	test("keeps the standalone HTML export contract", () => {
		expect(htmlExport.exportSessionToHtml).toBeFunction();
		expect(htmlExport.buildSessionData).toBeFunction();
		expect(packageManifest.exports["./export/html"]).toEqual({
			types: "./src/export/html/index.ts",
			import: "./src/export/html/index.ts",
		});
	});
});
