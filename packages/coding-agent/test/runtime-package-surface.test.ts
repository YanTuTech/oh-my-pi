import { describe, expect, test } from "bun:test";
import * as runtime from "@oh-my-pi/pi-coding-agent";
import * as htmlExport from "@oh-my-pi/pi-coding-agent/export/html";
import * as embeddedRuntime from "@oh-my-pi/pi-coding-agent/runtime";
import boundary from "../../../runtime-boundary.json" with { type: "json" };
import packageManifest from "../package.json" with { type: "json" };

const packageExports: Record<string, unknown> = packageManifest.exports;
const runtimeSurface: Record<string, unknown> = runtime;
const embeddedRuntimeSurface: Record<string, unknown> = embeddedRuntime;
const htmlExportSurface: Record<string, unknown> = htmlExport;

describe("headless runtime package surface", () => {
	test("keeps the embeddable runtime and RPC APIs", () => {
		for (const symbol of boundary.requiredRootSymbols) expect(runtimeSurface[symbol]).toBeFunction();
		expect(runtime.RpcClient.prototype.exportHtml).toBeFunction();
	});

	test("provides an SDK-only embedding entrypoint", () => {
		for (const symbol of boundary.requiredEmbeddedRuntimeSymbols)
			expect(embeddedRuntimeSurface[symbol]).toBeFunction();
		for (const symbol of boundary.forbiddenEmbeddedRuntimeSymbols)
			expect(symbol in embeddedRuntimeSurface).toBeFalse();
	});

	test("does not expose terminal product entrypoints", () => {
		expect("bin" in packageManifest).toBeFalse();
		for (const subpath of boundary.blockedPackageExports) expect(packageExports[subpath]).toBeNull();
		for (const symbol of boundary.forbiddenPublicSymbols) expect(symbol in runtimeSurface).toBeFalse();
	});

	test("keeps the standalone HTML export contract", () => {
		for (const symbol of boundary.requiredHtmlExportSymbols) expect(htmlExportSurface[symbol]).toBeFunction();
		expect(packageManifest.exports["./export/html"]).toEqual({
			types: "./src/export/html/index.ts",
			import: "./src/export/html/index.ts",
		});
	});
});
