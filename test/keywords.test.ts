import test from "node:test";
import assert from "node:assert/strict";
import revdiffPlanExtension, { buildKeywordRegex, TRIGGER_KEYWORDS } from "../index.js";

// ── Minimal ExtensionAPI stub ────────────────────────────────────────────────
// Enough surface to mount the extension and fire input events.

type InputSource = "interactive" | "rpc" | "extension";

function buildStub() {
	let tools: string[] = ["read", "write", "bash"];
	const inputHandlers: Array<(event: { type: "input"; text: string; source: InputSource }, ctx: unknown) => unknown> = [];
	const notifications: Array<{ msg: string; level: string }> = [];

	const ctx = {
		cwd: "/repo",
		sessionManager: { getBranch: () => [] },
		signal: new AbortController().signal,
		hasUI: false,
		ui: {
			notify(msg: string, level: string) { notifications.push({ msg, level }); },
			setStatus() {},
			setWidget() {},
			theme: { fg: (_: string, s: string) => s, strikethrough: (s: string) => s },
		},
	};

	const pi = {
		getActiveTools() { return [...tools]; },
		setActiveTools(next: string[]) { tools = [...next]; },
		appendEntry() {},
		getFlag() { return false; },
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (event === "input") inputHandlers.push(handler as never);
		},
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		sendUserMessage() {},
		sendMessage() {},
		exec() { return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false }); },
	};

	// Mount the extension — registers all event handlers.
	revdiffPlanExtension(pi as never);

	async function emitInput(text: string, source: InputSource) {
		for (const h of inputHandlers) {
			await h({ type: "input", text, source }, ctx);
		}
	}

	return { pi, ctx, emitInput, notifications, getTools: () => [...tools] };
}

test("TRIGGER_KEYWORDS is a non-empty array of strings", () => {
	assert.ok(Array.isArray(TRIGGER_KEYWORDS));
	assert.ok(TRIGGER_KEYWORDS.length > 0);
	for (const kw of TRIGGER_KEYWORDS) {
		assert.equal(typeof kw, "string");
	}
});

test("buildKeywordRegex returns null for empty list", () => {
	assert.equal(buildKeywordRegex([]), null);
});

test("buildKeywordRegex matches each default keyword (case-insensitive)", () => {
	const re = buildKeywordRegex(TRIGGER_KEYWORDS);
	assert.ok(re !== null);
	for (const kw of TRIGGER_KEYWORDS) {
		assert.ok(re.test(kw), `should match "${kw}"`);
		assert.ok(re.test(kw.toUpperCase()), `should match "${kw.toUpperCase()}"`);
		assert.ok(re.test(`can you ${kw} this`), `should match keyword inside sentence`);
	}
});

test("buildKeywordRegex does not match substring of a keyword", () => {
	const re = buildKeywordRegex(["plan"]);
	assert.ok(re !== null);
	assert.ok(!re.test("explanation"), `"explanation" should not match "plan"`);
	assert.ok(!re.test("planck"), `"planck" should not match "plan"`);
	assert.ok(!re.test("warplane"), `"warplane" should not match "plan"`);
});

test("buildKeywordRegex matches keyword at start and end of string", () => {
	const re = buildKeywordRegex(["spec"]);
	assert.ok(re !== null);
	assert.ok(re.test("spec this out"), `keyword at start`);
	assert.ok(re.test("write a spec"), `keyword at end`);
	assert.ok(re.test("spec"), `keyword alone`);
});

test("buildKeywordRegex does not match when text has no keyword", () => {
	const re = buildKeywordRegex(TRIGGER_KEYWORDS);
	assert.ok(re !== null);
	assert.ok(!re.test("just explain this code"));
	assert.ok(!re.test("refactor the module"));
	assert.ok(!re.test(""));
});

test("buildKeywordRegex escapes regex special chars in keywords (no throw)", () => {
	// Ensures special chars don't cause a SyntaxError in the RegExp constructor.
	assert.doesNotThrow(() => buildKeywordRegex(["c++", "plan"]));
	// Ordinary keyword still works alongside the special-char one.
	const re = buildKeywordRegex(["c++", "plan"]);
	assert.ok(re !== null);
	assert.ok(re.test("plan"));
});

// ── Source-filter integration tests ──────────────────────────────────────────────
// These exercise the extension's input handler via a lightweight stub so we
// can verify the source guard without spinning up the full Pi runtime.

test("input handler: 'extension' source does not trigger plan mode even with keyword", async () => {
	const { emitInput, getTools } = buildStub();
	const toolsBefore = getTools();

	await emitInput("let's plan this feature", "extension");

	// plan_submit must NOT have been added — phase stays idle
	assert.deepEqual(getTools(), toolsBefore,
		"tools should be unchanged when source is 'extension'");
});

test("input handler: 'rpc' source does not trigger plan mode even with keyword", async () => {
	const { emitInput, getTools } = buildStub();
	const toolsBefore = getTools();

	await emitInput("design the new architecture", "rpc");

	assert.deepEqual(getTools(), toolsBefore,
		"tools should be unchanged when source is 'rpc'");
});

test("input handler: 'interactive' source DOES trigger plan mode when keyword present", async () => {
	const { emitInput, getTools } = buildStub();

	await emitInput("let's plan this feature", "interactive");

	// enterPlanning() adds plan_submit to the tool list
	assert.ok(getTools().includes("plan_submit"),
		"plan_submit should be in active tools after interactive keyword trigger");
});

test("input handler: 'interactive' source without keyword does not trigger plan mode", async () => {
	const { emitInput, getTools } = buildStub();
	const toolsBefore = getTools();

	await emitInput("just fix the bug", "interactive");

	assert.deepEqual(getTools(), toolsBefore,
		"tools should be unchanged when no keyword is present");
});
