/**
 * The native project walk-up must never treat `~/.omp` as a project config dir.
 * A cwd under home with no closer repo root (Windows temp dirs, scratch folders)
 * otherwise loads the user's ~/.omp/SYSTEM.md, RULES.md and AGENTS.md as project
 * config, even when the agent dir points elsewhere (profiles, isolated runs).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { SystemPrompt } from "@oh-my-pi/pi-coding-agent/capability/system-prompt";
import { systemPromptCapability } from "@oh-my-pi/pi-coding-agent/capability/system-prompt";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { getAncestorDirs } from "@oh-my-pi/pi-coding-agent/discovery/builtin";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

let tempDir: string;
let home: string;
// setAgentDir() rewrites the profile keys; integration tests temporarily redirect os.homedir().
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "HOME", "USERPROFILE"] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

type NativeItem = SystemPrompt | Rule | ContextFile | Skill;

const NATIVE_FILES = [
	{ id: systemPromptCapability.id, file: "SYSTEM.md" },
	{ id: ruleCapability.id, file: "RULES.md" },
	{ id: contextFileCapability.id, file: "AGENTS.md" },
	{ id: skillCapability.id, file: path.join("skills", "operator", "SKILL.md") },
];

const PATH_SPELLINGS = [
	{ name: "case", windowsOnly: true, spell: (dir: string) => dir.toUpperCase() },
	{ name: "slashes", windowsOnly: true, spell: (dir: string) => dir.replaceAll("\\", "/") },
	{ name: "dot component", windowsOnly: false, spell: (dir: string) => `${dir}${path.sep}.` },
];

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function writeNativeFiles(dir: string): void {
	writeFile(path.join(dir, ".omp", "SYSTEM.md"), "operator system prompt\n");
	writeFile(path.join(dir, ".omp", "RULES.md"), "operator rule\n");
	writeFile(path.join(dir, ".omp", "AGENTS.md"), "operator agents\n");
	writeFile(
		path.join(dir, ".omp", "skills", "operator", "SKILL.md"),
		"---\nname: operator\ndescription: operator skill\n---\nbody\n",
	);
}

async function loadNative<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const native = getCapability(capabilityId)?.providers.find(p => p.id === "native");
	if (!native) throw new Error(`native provider missing for ${capabilityId}`);
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: T[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-walkup-"));
	home = path.join(tempDir, "home");
	// The user config root holds operator files; the active agent dir is isolated elsewhere.
	writeNativeFiles(home);
	setAgentDir(path.join(tempDir, "isolated-agent"));
});

afterEach(() => {
	clearCache();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	__resetDirsFromEnvForTests();
	removeSyncWithRetries(tempDir);
});

test("a cwd under home without a repo does not load ~/.omp files as project config", async () => {
	const cwd = path.join(home, "AppData", "Local", "Temp", "work");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx: LoadContext = { cwd, home, repoRoot: null };

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
	const rules = await loadNative<Rule>(ruleCapability.id, ctx);
	const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
	const skills = await loadNative<Skill>(skillCapability.id, ctx);

	const fromHome = (p: string) => p.startsWith(path.join(home, ".omp") + path.sep);
	expect(prompts.filter(p => fromHome(p.path))).toEqual([]);
	expect(rules.filter(r => fromHome(r.path))).toEqual([]);
	expect(contexts.filter(c => fromHome(c.path))).toEqual([]);
	expect(skills.filter(s => fromHome(s.path))).toEqual([]);
});

test("a project .omp between cwd and home is still found", async () => {
	const project = path.join(home, "scratch");
	const cwd = path.join(project, "nested");
	fs.mkdirSync(cwd, { recursive: true });
	writeFile(path.join(project, ".omp", "SYSTEM.md"), "project system prompt\n");

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, { cwd, home, repoRoot: null });

	expect(prompts.map(p => [p.path, p.level])).toEqual([[path.join(project, ".omp", "SYSTEM.md"), "project"]]);
});

for (const spelling of PATH_SPELLINGS) {
	const platformTest = test.skipIf(spelling.windowsOnly && process.platform !== "win32");

	for (const capability of NATIVE_FILES) {
		for (const changed of ["cwd", "home"] as const) {
			platformTest(`${capability.id} excludes home with ${spelling.name} differences in ${changed}`, async () => {
				const cwd = path.join(home, "scratch", "nested");
				fs.mkdirSync(cwd, { recursive: true });
				// A missed stop boundary must not discover config above home either.
				writeNativeFiles(tempDir);
				const ctx: LoadContext = { cwd, home, repoRoot: null };
				ctx[changed] = spelling.spell(ctx[changed]);

				expect(await loadNative<NativeItem>(capability.id, ctx)).toEqual([]);
			});
		}

		platformTest(`${capability.id} keeps the nearer project with ${spelling.name} differences`, async () => {
			const project = path.join(home, "scratch");
			const cwd = path.join(project, "nested");
			fs.mkdirSync(cwd, { recursive: true });
			writeNativeFiles(project);
			writeNativeFiles(tempDir);

			const items = await loadNative<NativeItem>(capability.id, {
				cwd: spelling.spell(cwd),
				home,
				repoRoot: null,
			});
			expect(items.map(item => [path.relative(project, item.path), item._source.level])).toEqual([
				[path.join(".omp", capability.file), "project"],
			]);
		});
	}

	platformTest(`ancestor boundary tolerates ${spelling.name} differences and includes its depth`, () => {
		const cwd = path.join(home, "scratch", "nested");
		expect(getAncestorDirs(cwd, spelling.spell(home))).toEqual([
			{ dir: cwd, depth: 0 },
			{ dir: path.dirname(cwd), depth: 1 },
			{ dir: home, depth: 2 },
		]);
	});

	platformTest(`native capabilities honor repo-root boundaries with ${spelling.name} differences`, async () => {
		const project = path.join(home, "scratch");
		const cwd = path.join(project, "nested");
		fs.mkdirSync(cwd, { recursive: true });
		writeNativeFiles(tempDir);
		for (const capability of NATIVE_FILES) {
			expect(await loadNative<NativeItem>(capability.id, { cwd, home, repoRoot: spelling.spell(project) })).toEqual(
				[],
			);
		}
	});

	platformTest(`loadCapability uses os.homedir() with ${spelling.name} differences`, async () => {
		const cwd = path.join(home, "scratch", "nested");
		fs.mkdirSync(cwd, { recursive: true });
		writeNativeFiles(tempDir);
		// Keep the home case unchanged so a differently-cased cwd exercises the real mismatch.
		const runtimeHome = spelling.name === "case" ? home : spelling.spell(home);
		process.env.HOME = runtimeHome;
		process.env.USERPROFILE = runtimeHome;
		expect(os.homedir()).toBe(runtimeHome);

		for (const capability of NATIVE_FILES) {
			const result = await loadCapability<NativeItem>(capability.id, {
				cwd: spelling.spell(cwd),
				providers: ["native"],
			});
			expect(result.warnings).toEqual([]);
			expect(result.items).toEqual([]);
		}

		const project = path.dirname(cwd);
		writeNativeFiles(project);
		clearCache();
		for (const capability of NATIVE_FILES) {
			const result = await loadCapability<NativeItem>(capability.id, {
				cwd: spelling.spell(cwd),
				providers: ["native"],
			});
			expect(result.warnings).toEqual([]);
			expect(result.items.map(item => [path.relative(project, item.path), item._source.level])).toEqual([
				[path.join(".omp", capability.file), "project"],
			]);
		}
	});
}

test("ancestor walk without a boundary still reaches the filesystem root", () => {
	const cwd = path.join(home, "scratch");
	const ancestors = getAncestorDirs(cwd);
	expect(ancestors[0]).toEqual({ dir: cwd, depth: 0 });
	expect(ancestors.at(-1)?.dir).toBe(path.parse(cwd).root);
	expect(ancestors.map(ancestor => ancestor.depth)).toEqual(ancestors.map((_, index) => index));
});
