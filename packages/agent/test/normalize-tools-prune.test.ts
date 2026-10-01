import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import { AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core/append-only-context";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Context } from "@oh-my-pi/pi-ai";
import { renderToolInventory } from "@oh-my-pi/pi-ai/dialect/inventory";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const toolSchema = type({
	path: type("string").describe("where to read"),
	nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
});

function makeTool(): AgentTool<typeof toolSchema, { path: string }> {
	return {
		name: "demo",
		label: "Demo",
		description: "top-level tool description",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** Read the `properties` map off a wire JSON schema with runtime narrowing. */
function wireProps(parameters: unknown): Record<string, unknown> {
	if (!parameters || typeof parameters !== "object" || !("properties" in parameters)) {
		throw new Error("expected a wire schema with properties");
	}
	const properties = parameters.properties;
	if (!properties || typeof properties !== "object") throw new Error("expected a properties object");
	// Narrowed to a non-null object above; wire property maps are plain string-keyed objects.
	const map = properties as Record<string, unknown>;
	return map;
}

function hasField(parameters: unknown, field: string): boolean {
	return field in wireProps(parameters);
}

function fieldDescription(parameters: unknown, field: string): unknown {
	const value = wireProps(parameters)[field];
	if (value && typeof value === "object" && "description" in value) return value.description;
	return undefined;
}

function providerTool(tools: Context["tools"]) {
	const model = getBundledModel<"openai-responses">("openai", "gpt-5-mini");
	if (!model) throw new Error("Expected bundled OpenAI GPT-5 Mini model");
	const { params } = buildParams(
		model,
		{ messages: [{ role: "user", content: "Read the file", timestamp: 0 }], tools },
		undefined,
		undefined,
	);
	const tool = params.tools?.[0];
	if (tool?.type !== "function") throw new Error("Expected a provider function tool");
	return tool;
}

describe("normalizeTools — pruneDescriptions", () => {
	it("retains a concise native description without duplicating catalog details or schema annotations", () => {
		const source = makeTool();
		source.summary = "  Read a file safely.\nLong summary detail.";
		source.description = "Read a file.\n\nFull catalog instructions.";
		source.examples = [{ caption: "Catalog-only example", call: { path: "demo.txt", nested: { inner: "value" } } }];
		const catalog = renderToolInventory([source]);
		const tools = normalizeTools([source], { injectIntent: true, pruneDescriptions: true });
		const tool = providerTool(tools);
		expect(tool.description).toBe("Read a file safely.");
		expect(JSON.stringify(tool)).not.toContain("Full catalog instructions");
		expect(JSON.stringify(tool)).not.toContain("Catalog-only example");
		expect(catalog).toContain("Full catalog instructions");
		expect(catalog).toContain("Catalog-only example");
		expect(catalog).toContain("where to read");
		const wire = JSON.stringify(tool?.parameters);
		expect(wire).not.toContain("where to read");
		expect(wire).not.toContain("inner value");
		expect(wire).not.toContain("a nested object");
		// Structure is preserved.
		expect(hasField(tool.parameters, "path")).toBe(true);
		expect(hasField(tool.parameters, "nested")).toBe(true);
		expect(hasField(tool.parameters, INTENT_FIELD)).toBe(true);
		expect(tool.parameters?.required).toContain(INTENT_FIELD);
		expect(fieldDescription(tool.parameters, INTENT_FIELD)).toBeUndefined();
	});

	it("falls back to the first nonblank description line for tools without a summary", () => {
		const source = makeTool();
		source.description = "\n \nRead files.\r\n\nDetailed extension guidance.";
		const pruned = providerTool(normalizeTools([source], { injectIntent: false, pruneDescriptions: true }));
		expect(pruned.description).toBe("Read files.");
		expect(JSON.stringify(pruned.parameters)).not.toContain("where to read");

		const full = providerTool(normalizeTools([source], { injectIntent: false }));
		expect(full.description).toContain("Detailed extension guidance");
		expect(JSON.stringify(full.parameters)).toContain("where to read");
	});

	it("refreshes the provider description when a live summary changes under an append-only prefix", () => {
		let summary = "Read files.";
		const source: AgentTool<typeof toolSchema, { path: string }> = {
			...makeTool(),
			get summary() {
				return summary;
			},
		};
		const context: AgentContext = { systemPrompt: [renderToolInventory([source])], messages: [], tools: [source] };
		const manager = new AppendOnlyContextManager();
		const options = { intentTracing: true, pruneToolDescriptions: true };
		const first = manager.build(context, options);
		expect(providerTool(first.tools).description).toBe("Read files.");

		summary = "Read files with snapshot anchors.";
		const updated = manager.build(context, options);
		expect(providerTool(updated.tools).description).toBe("Read files with snapshot anchors.");
		expect(updated.tools?.[0]?.parameters).toBe(first.tools?.[0]?.parameters);
	});

	it("reuses injected parameters by identity across calls so downstream schema memos hit", () => {
		const tool = makeTool();
		for (const pruneDescriptions of [false, true]) {
			const first = normalizeTools([tool], { injectIntent: true, pruneDescriptions })?.[0]?.parameters;
			const second = normalizeTools([tool], { injectIntent: true, pruneDescriptions })?.[0]?.parameters;
			expect(first).toBeDefined();
			expect(second).toBe(first);
		}
		const bare = normalizeTools([tool], { injectIntent: true, pruneDescriptions: true })?.[0]?.parameters;
		const described = normalizeTools([tool], { injectIntent: true })?.[0]?.parameters;
		expect(described).not.toBe(bare);
	});

	it("injects the intent field WITHOUT a description when pruning", () => {
		const tools = normalizeTools([makeTool()], { injectIntent: true, pruneDescriptions: true });
		const params = tools?.[0]?.parameters;
		expect(hasField(params, INTENT_FIELD)).toBe(true);
		expect(fieldDescription(params, INTENT_FIELD)).toBeUndefined();
		// No description text rides the wire at all.
		expect(JSON.stringify(params)).not.toContain("description");
	});

	it("keeps the intent field description when not pruning", () => {
		const tools = normalizeTools([makeTool()], { injectIntent: true });
		expect(typeof fieldDescription(tools?.[0]?.parameters, INTENT_FIELD)).toBe("string");
	});
});

describe("normalizeTools — omit-intent tools", () => {
	it("wire-encodes arktype parameters when intent is a function", () => {
		const params = type({ action: "string", reason: "string" });
		const tool: AgentTool<typeof params> = {
			name: "resolve",
			label: "Resolve",
			description: "",
			parameters: params,
			intent: () => "resolving",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const out = normalizeTools([tool], { injectIntent: true })?.[0];
		expect(out?.parameters).toMatchObject({ type: "object" });
		expect(hasField(out?.parameters, "action")).toBe(true);
		expect(hasField(out?.parameters, "reason")).toBe(true);
		// Function intent => intentMode is "omit"; INTENT_FIELD must NOT be injected.
		expect(hasField(out?.parameters, INTENT_FIELD)).toBe(false);
	});

	it("wire-encodes arktype parameters when intent is the literal 'omit'", () => {
		const params = type({ note: "string" });
		const tool: AgentTool<typeof params> = {
			name: "demo-omit",
			label: "Demo",
			description: "",
			parameters: params,
			intent: "omit",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const out = normalizeTools([tool], { injectIntent: true })?.[0];
		expect(out?.parameters).toMatchObject({ type: "object" });
		expect(hasField(out?.parameters, "note")).toBe(true);
		expect(hasField(out?.parameters, "i")).toBe(false);
	});

	it("wire-encodes parameters even when intent injection is disabled globally", () => {
		const out = normalizeTools([makeTool()], { injectIntent: false })?.[0];
		expect(out?.parameters).toMatchObject({ type: "object" });
		expect(hasField(out?.parameters, "path")).toBe(true);
		expect(hasField(out?.parameters, "nested")).toBe(true);
	});
});

describe("normalizeTools — union-shaped schemas", () => {
	const variantOne = type({
		action: type("'open'").describe("operation"),
		"name?": "string",
	});
	const variantTwo = type({
		action: type("'run'").describe("operation"),
		code: "string",
	});
	const unionSchema = variantOne.or(variantTwo);

	function unionTool(): AgentTool<typeof unionSchema, { ok: true }> {
		return {
			name: "discriminated",
			label: "Discriminated",
			description: "tool whose parameters union over an action discriminator",
			parameters: unionSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
	}

	it("injects the intent field into each anyOf branch", () => {
		const out = normalizeTools([unionTool()], { injectIntent: true })?.[0];
		const params = out?.parameters as {
			anyOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
		};
		const branches = params.anyOf ?? [];
		expect(branches.length).toBeGreaterThan(0);
		for (const branch of branches) {
			expect(branch.properties?.[INTENT_FIELD]).toBeDefined();
			expect(branch.required ?? []).toContain(INTENT_FIELD);
		}
	});

	it("does not add root-sibling properties next to a pure anyOf", () => {
		// Root must stay a pure union; adding sibling `properties: { i }` /
		// `required: [i]` collides with each closed branch's
		// `additionalProperties: false` and leaves no satisfiable input.
		const out = normalizeTools([unionTool()], { injectIntent: true })?.[0];
		const params = out?.parameters as Record<string, unknown>;
		expect(params.properties).toBeUndefined();
		expect(params.required).toBeUndefined();
	});
});
