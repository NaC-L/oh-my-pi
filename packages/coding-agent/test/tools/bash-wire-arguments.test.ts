import { describe, expect, it } from "bun:test";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const model = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
} as ModelSpec<"openai-responses">);

function makeTool(asyncEnabled: boolean, launchEnabled: boolean): BashTool {
	const session: ToolSession = {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "async.enabled": asyncEnabled, "launch.enabled": launchEnabled }),
	};
	return new BashTool(session);
}

describe("bash optional wire arguments", () => {
	it.each([
		{ asyncEnabled: false, launchEnabled: false },
		{ asyncEnabled: true, launchEnabled: false },
		{ asyncEnabled: false, launchEnabled: true },
		{ asyncEnabled: true, launchEnabled: true },
	])(
		"permits omission without forced nullable fields ($asyncEnabled, $launchEnabled)",
		({ asyncEnabled, launchEnabled }) => {
			const tool = makeTool(asyncEnabled, launchEnabled);
			const wire = convertTools([tool], true, model)[0] as {
				parameters: Record<string, unknown>;
			};
			expect(isJsonSchemaValueValid(wire.parameters, { command: "echo hi" })).toBe(true);
			expect(isJsonSchemaValueValid(wire.parameters, { command: "echo hi", timeout: null })).toBe(false);
			expect(isJsonSchemaValueValid(wire.parameters, { command: "echo hi", pty: false })).toBe(true);
			if (asyncEnabled) {
				expect(isJsonSchemaValueValid(wire.parameters, { command: "echo hi", async: false })).toBe(true);
			}
			if (launchEnabled) {
				expect(
					isJsonSchemaValueValid(wire.parameters, {
						command: "echo hi",
						name: "service",
						ready: { log: "ready" },
					}),
				).toBe(true);
			}
		},
	);

	it("keeps null normalization, explicit false and zero while rejecting invalid calls locally", () => {
		const tool = makeTool(true, true);
		const normalized = validateToolArguments(tool, {
			id: "null-optionals",
			type: "toolCall",
			name: "bash",
			arguments: { command: "echo hi", cwd: null, timeout: null, pty: false, async: false },
		});
		expect(normalized).toEqual({ command: "echo hi", pty: false, async: false });
		const unlimited = validateToolArguments(tool, {
			id: "zero-timeout",
			type: "toolCall",
			name: "bash",
			arguments: { command: "echo hi", timeout: 0, ready: { log: "ready", host: null, port: null } },
		});
		expect(unlimited.timeout).toBe(0);
		expect(unlimited.ready).toEqual({ log: "ready" });
		expect(() =>
			validateToolArguments(tool, {
				id: "missing-command",
				type: "toolCall",
				name: "bash",
				arguments: { pty: false },
			}),
		).toThrow();
		expect(() =>
			validateToolArguments(tool, {
				id: "long-name",
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo hi", name: "x".repeat(49) },
			}),
		).toThrow();
	});
});
