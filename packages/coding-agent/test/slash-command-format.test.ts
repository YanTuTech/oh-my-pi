import { describe, expect, it } from "bun:test";
import { renderAsciiBar } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/format";

describe("renderAsciiBar", () => {
	it("renders completed progress without a terminal theme", () => {
		expect(renderAsciiBar(0.5, 4)).toBe("[██░░] 50%");
	});

	it("renders an unstyled placeholder when progress is unknown", () => {
		expect(renderAsciiBar(undefined, 4)).toBe("[····]");
	});
});
