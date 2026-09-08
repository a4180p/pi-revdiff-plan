import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReviewOutcome,
	getAssistantText,
	isPlanPathAllowed,
	markCompletedSteps,
	parseChecklist,
} from "../index.js";

test("parseChecklist parses unchecked, checked, and DONE markers", () => {
	const items = parseChecklist(
		[
			"- [ ] first",
			"- [x] second",
			"- [DONE:2] third",
			"not a checklist item",
		].join("\n"),
	);

	assert.deepEqual(items, [
		{ text: "first", completed: false },
		{ text: "second", completed: true },
		{ text: "third", completed: true },
	]);
});

test("markCompletedSteps matches inline markers and ignores code blocks", () => {
	const items = [
		{ text: "first", completed: false },
		{ text: "second", completed: false },
		{ text: "third", completed: false },
	];

	// [DONE:1] is on its own line — should fire
	// [DONE:2] is inside a fenced code block — should NOT fire
	// [DONE:0] is inline at end of sentence — should fire
	const count = markCompletedSteps(
		[
			"Finished work.",
			"[DONE:1]",
			"```ts",
			"const marker = '[DONE:2]';",
			"```",
			"Updated the readme. [DONE:0]",
		].join("\n"),
		items,
	);

	assert.equal(count, 2);
	assert.deepEqual(items, [
		{ text: "first", completed: true },
		{ text: "second", completed: true },
		{ text: "third", completed: false },
	]);
});

test("markCompletedSteps ignores markers inside fenced code blocks", () => {
	const items = [{ text: "only item", completed: false }];

	const count = markCompletedSteps(
		"Here is an example:\n```\n[DONE:0]\n```\nDone!",
		items,
	);

	assert.equal(count, 0);
	assert.equal(items[0]!.completed, false);
});

test("isPlanPathAllowed requires markdown within cwd", () => {
	const cwd = "/repo";
	assert.equal(isPlanPathAllowed("PLAN.md", cwd), true);
	assert.equal(isPlanPathAllowed("plans/feature.mdx", cwd), true);
	assert.equal(isPlanPathAllowed("README.txt", cwd), false);
	assert.equal(isPlanPathAllowed("../escape.md", cwd), false);
	assert.equal(isPlanPathAllowed("", cwd), false);
	// Matches plannotator's isPlanWritePathAllowed: an absolute path is judged by
	// containment, so one pointing inside cwd is allowed.
	assert.equal(isPlanPathAllowed("/repo/PLAN.md", cwd), true);
	assert.equal(isPlanPathAllowed("/elsewhere/PLAN.md", cwd), false);
});

test("classifyReviewOutcome maps revdiff's two exit signals", () => {
	assert.deepEqual(classifyReviewOutcome("", 0, ""), {
		outcome: "approved",
		annotations: "",
	});
	assert.deepEqual(classifyReviewOutcome("", 10, "line 3: rethink this"), {
		outcome: "feedback",
		annotations: "line 3: rethink this",
	});
});

test("classifyReviewOutcome reports a session that ended without a decision", () => {
	// A crash, a signal, or a missing binary is not plan feedback: the agent must
	// not try to revise the plan in response to it.
	for (const exitCode of [1, 130, null]) {
		const result = classifyReviewOutcome("", exitCode, "");
		assert.equal(result.outcome, "closed", `exit ${exitCode} should be closed`);
	}

	assert.equal(
		classifyReviewOutcome("spawn ENOENT", null, "").outcome,
		"closed",
	);
});

test("getAssistantText extracts text blocks from assistant message", () => {
	const text = getAssistantText({
		role: "assistant",
		content: [
			{ type: "text", text: "hello" },
			{ type: "tool_use", name: "x" },
			{ type: "text", text: "world" },
		],
	});
	assert.equal(text, "hello\nworld");
});
