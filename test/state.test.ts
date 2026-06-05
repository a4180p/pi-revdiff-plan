import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { restoreState, type RuntimeState, EXECUTE_ENTRY_TYPE, PLAN_SUBMIT_TOOL, STATE_ENTRY_TYPE } from "../index.js";

const MARK_DONE_TOOL = "mark_done";

function createState(): RuntimeState {
	return {
		phase: "idle",
		lastSubmittedPath: null,
		savedTools: [],
		checklistItems: [],
		submitCount: 0,
		lastReviewedPath: null,
	};
}

function createPi(activeTools: string[] = ["read", "write", PLAN_SUBMIT_TOOL]) {
	let tools = [...activeTools];
	return {
		appendEntry() {},
		getActiveTools() {
			return [...tools];
		},
		setActiveTools(next: string[]) {
			tools = [...next];
		},
	};
}

test("restoreState restores executing checklist progress and active tools", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "revdiff-plan-test-"));
	try {
		writeFileSync(path.join(dir, "PLAN.md"), "- [ ] one\n- [ ] two\n");
		const entries = [
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { phase: "executing", lastSubmittedPath: "PLAN.md", savedTools: ["read", "bash"] },
			},
			{ type: "custom", customType: EXECUTE_ENTRY_TYPE, data: { lastSubmittedPath: "PLAN.md" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Done\n[DONE:1]" }] },
			},
		];
		const pi = createPi();
		const state = createState();
		let updated = 0;
		restoreState(
			pi as never,
			{ cwd: dir, sessionManager: { getBranch: () => entries } } as never,
			state,
			() => {
				updated++;
			},
		);

		assert.equal(state.phase, "executing");
		assert.equal(state.lastSubmittedPath, "PLAN.md");
		assert.deepEqual(state.checklistItems, [
			{ text: "one", completed: false },
			{ text: "two", completed: true },
		]);
		// Bug 2 is fixed: mark_done must be present after restore
		const tools = pi.getActiveTools();
		assert.ok(tools.includes(MARK_DONE_TOOL), `mark_done must be in active tools; got: ${tools.join(", ")}`);
		assert.ok(!tools.includes(PLAN_SUBMIT_TOOL), "plan_submit must not appear in executing tool set");
		assert.equal(updated, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restoreState honors cleared state and removes plan_submit", () => {
	const pi = createPi(["read", PLAN_SUBMIT_TOOL, "write"]);
	const state = createState();
	const entries = [
		{
			type: "custom",
			customType: STATE_ENTRY_TYPE,
			data: { phase: "planning", lastSubmittedPath: null, savedTools: ["read"] },
		},
		{
			type: "custom",
			customType: STATE_ENTRY_TYPE,
			data: { cleared: true },
		},
	];

	let updated = 0;
	restoreState(
		pi as never,
		{ cwd: "/repo", sessionManager: { getBranch: () => entries } } as never,
		state,
		() => {
			updated++;
		},
	);

	assert.equal(state.phase, "idle");
	assert.deepEqual(pi.getActiveTools(), ["read", "write"]);
	assert.equal(updated, 0);
});

test("restoreState restores planning tools including plan_submit", () => {
	const pi = createPi(["read", "bash"]);
	const state = createState();
	const entries = [
		{
			type: "custom",
			customType: STATE_ENTRY_TYPE,
			data: { phase: "planning", lastSubmittedPath: null, savedTools: ["read", "bash"] },
		},
	];

	let updated = 0;
	restoreState(
		pi as never,
		{ cwd: "/repo", sessionManager: { getBranch: () => entries } } as never,
		state,
		() => {
			updated++;
		},
	);

	assert.equal(state.phase, "planning");
	assert.deepEqual(pi.getActiveTools(), ["read", "bash", PLAN_SUBMIT_TOOL]);
	assert.equal(updated, 1);
});

test("restoreState (exported): mark_done IS in active tools after restoring an executing-phase session", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "revdiff-plan-test-"));
	try {
		writeFileSync(path.join(dir, "PLAN.md"), "- [ ] step one\n- [ ] step two\n");
		const entries = [
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { phase: "executing", lastSubmittedPath: "PLAN.md", savedTools: ["read", "bash"] },
			},
			{ type: "custom", customType: EXECUTE_ENTRY_TYPE, data: { lastSubmittedPath: "PLAN.md" } },
		];
		const pi = createPi(["read", "bash"]);
		const state = createState();
		let updated = 0;
		restoreState(
			pi as never,
			{ cwd: dir, sessionManager: { getBranch: () => entries } } as never,
			state,
			() => { updated++; },
		);

		assert.equal(state.phase, "executing");
		const tools = pi.getActiveTools();
		assert.ok(
			tools.includes(MARK_DONE_TOOL),
			`mark_done must be in active tools after restore; got: ${tools.join(", ")}`,
		);
		// plan_submit must not leak into the executing tool set
		assert.ok(!tools.includes(PLAN_SUBMIT_TOOL), "plan_submit must not be in executing tool set");
		assert.equal(updated, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
