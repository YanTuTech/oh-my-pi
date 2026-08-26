/**
 * Regression (issue #8096): a configured-but-unreachable auth broker must not
 * surface actionable recovery guidance instead of a raw `AuthBrokerError`.
 *
 * The broker deliberately replaces the local credential store when configured,
 * so an unreachable broker stays fatal — the fix is the recovery guidance, not
 * a silent fallback to local credentials.
 */
import { describe, expect, it } from "bun:test";
import { AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { describeAuthBrokerStartupError } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";

describe("describeAuthBrokerStartupError", () => {
	it("turns a broker connection failure into recovery guidance", async () => {
		const message = await describeAuthBrokerStartupError(
			new AuthBrokerError("Auth broker request failed after 2 attempt(s)"),
		);
		expect(message).not.toBeNull();
		expect(message).toContain("Auth broker request failed after 2 attempt(s)");
		// Both recovery routes the reporter asked for: start it, or disable it.
		expect(message).toContain("omp auth-broker serve");
		expect(message).toContain("omp config reset auth.broker.url");
		expect(message).toContain("OMP_AUTH_BROKER_URL");
	});

	it("names the configured broker URL when it can be resolved", async () => {
		const prevUrl = process.env.OMP_AUTH_BROKER_URL;
		const prevToken = process.env.OMP_AUTH_BROKER_TOKEN;
		process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
		process.env.OMP_AUTH_BROKER_TOKEN = "test-token";
		try {
			const message = await describeAuthBrokerStartupError(new AuthBrokerError("connection refused"));
			expect(message).toContain("http://127.0.0.1:8765");
		} finally {
			if (prevUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
			else process.env.OMP_AUTH_BROKER_URL = prevUrl;
			if (prevToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
			else process.env.OMP_AUTH_BROKER_TOKEN = prevToken;
		}
	});

	it("passes through a missing-token message unchanged", async () => {
		const err = new MissingApiKeyError(undefined, "OMP_AUTH_BROKER_URL is set but no bearer token is available.");
		expect(await describeAuthBrokerStartupError(err)).toBe(err.message);
	});

	it("returns null for unrelated errors so the caller rethrows them", async () => {
		expect(await describeAuthBrokerStartupError(new Error("boom"))).toBeNull();
		expect(await describeAuthBrokerStartupError(new TypeError("nope"))).toBeNull();
	});
});
