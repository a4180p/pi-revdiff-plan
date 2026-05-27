/**
 * revdiff-plan — Plan mode for pi using revdiff TUI for plan review.
 *
 * State machine: idle → planning → executing → idle
 *
 * During planning:
 * - Agent explores codebase, writes a markdown plan file
 * - Writes/edits restricted to .md/.mdx files inside cwd
 * - Agent calls plan_submit(filePath) to request review
 * - revdiff opens with --only=<file>; user annotates or quits clean
 * - No annotations → approved → transition to executing
 * - Annotations → feedback returned to agent → agent revises → resubmit
 *
 * During executing:
 * - Full tool access
 * - Checklist progress tracked via [DONE:n] markers in agent responses
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "revdiff-plan-state";
const EXECUTE_ENTRY_TYPE = "revdiff-plan-execute";
const EXIT_CODE_ANNOTATIONS = 10;
const PLAN_SUBMIT_TOOL = "plan_submit";
const ALLOWED_EXTENSIONS = new Set([".md", ".mdx"]);

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = "idle" | "planning" | "executing";

interface ChecklistItem {
	text: string;
	completed: boolean;
}

interface PersistedState {
	phase: Phase;
	lastSubmittedPath: string | null;
	savedTools: string[];
}

interface ClearedState {
	cleared: true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlanPathAllowed(inputPath: string, cwd: string): boolean {
	if (!inputPath) return false;
	const abs = path.resolve(cwd, inputPath);
	const rel = path.relative(path.resolve(cwd), abs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	return ALLOWED_EXTENSIONS.has(path.extname(abs).toLowerCase());
}

function parseChecklist(markdown: string): ChecklistItem[] {
	return markdown.split("\n").flatMap((line) => {
		const m = /^\s*-\s+\[([ xX]|DONE:\d+)\]\s+(.+)$/.exec(line);
		if (!m) return [];
		return [{ text: m[2]!.trim(), completed: m[1] !== " " }];
	});
}

function markCompletedSteps(text: string, items: ChecklistItem[]): number {
	let count = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/g)) {
		const idx = Number.parseInt(match[1]!, 10);
		if (idx >= 0 && idx < items.length && !items[idx]!.completed) {
			items[idx]!.completed = true;
			count++;
		}
	}
	return count;
}

function resolveRevdiffBin(): string | undefined {
	const fromEnv = process.env.REVDIFF_BIN;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "revdiff");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function getAssistantText(message: unknown): string | null {
	if (
		typeof message !== "object" ||
		message === null ||
		(message as { role?: unknown }).role !== "assistant"
	) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const text = content
		.filter((b): b is { type: string; text: string } => b?.type === "text")
		.map((b) => b.text)
		.join("\n");
	return text.trim() || null;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function revdiffPlanExtension(pi: ExtensionAPI): void {
	let phase: Phase = "idle";
	let lastSubmittedPath: string | null = null;
	let savedTools: string[] = [];
	let checklistItems: ChecklistItem[] = [];
	let justApprovedPlan = false;

	// ── Persistence ───────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, { phase, lastSubmittedPath, savedTools } satisfies PersistedState);
	}

	// ── Status / Widget ───────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (phase === "planning") {
			ctx.ui.setStatus("revdiff-plan", ctx.ui.theme.fg("warning", "⏸ plan"));
			return;
		}
		if (phase === "executing") {
			if (checklistItems.length > 0) {
				const done = checklistItems.filter((t) => t.completed).length;
				ctx.ui.setStatus("revdiff-plan", ctx.ui.theme.fg("accent", `📋 ${done}/${checklistItems.length}`));
			} else {
				ctx.ui.setStatus("revdiff-plan", ctx.ui.theme.fg("accent", "▶ exec"));
			}
			return;
		}
		ctx.ui.setStatus("revdiff-plan", undefined);
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (phase !== "executing" || checklistItems.length === 0) {
			ctx.ui.setWidget("revdiff-plan-progress", undefined);
			return;
		}
		const lines = checklistItems.map((item) => {
			if (item.completed) {
				return (
					ctx.ui.theme.fg("success", "☑ ") +
					ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
				);
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
		ctx.ui.setWidget("revdiff-plan-progress", lines);
	}

	// ── Phase transitions ─────────────────────────────────────────────────

	function enterPlanning(ctx: ExtensionContext): void {
		phase = "planning";
		checklistItems = [];
		savedTools = pi.getActiveTools();
		pi.setActiveTools([...savedTools, PLAN_SUBMIT_TOOL]);
		persistState();
		updateStatus(ctx);
		ctx.ui.notify("Plan mode enabled. Agent will explore and write a plan file.", "info");
	}

	function exitToIdle(ctx: ExtensionContext): void {
		phase = "idle";
		checklistItems = [];
		lastSubmittedPath = null;
		pi.setActiveTools(savedTools.length > 0 ? savedTools : pi.getActiveTools().filter((t) => t !== PLAN_SUBMIT_TOOL));
		savedTools = [];
		persistState();
		updateStatus(ctx);
		updateWidget(ctx);
		ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (phase === "idle") {
			enterPlanning(ctx);
		} else {
			exitToIdle(ctx);
		}
	}

	// ── revdiff launch for plan review ────────────────────────────────────

	async function reviewPlanWithRevdiff(
		ctx: ExtensionContext,
		planPath: string,
	): Promise<{ approved: boolean; annotations: string }> {
		const revdiffBin = resolveRevdiffBin();
		if (!revdiffBin) {
			return { approved: false, annotations: "Error: revdiff binary not found. Install it with: brew install umputun/apps/revdiff" };
		}

		const tempDir = mkdtempSync(path.join(tmpdir(), "revdiff-plan-"));
		const outputFile = path.join(tempDir, "annotations.txt");
		let launchError = "";

		const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			const result = spawnSync(
				revdiffBin,
				["--only", planPath, `--output=${outputFile}`],
				{
					cwd: process.cwd(),
					env: { ...process.env, REVDIFF_EXIT_CODE_ON_ANNOTATIONS: "true" },
					stdio: "inherit",
				},
			);
			if (result.error) launchError = result.error.message;
			tui.start();
			tui.requestRender(true);
			done(result.status ?? (result.error ? 1 : 0));
			return { render: () => [], invalidate() {} };
		});

		const rawOutput = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

		if (launchError) {
			return { approved: false, annotations: `Error launching revdiff: ${launchError}` };
		}
		if (typeof exitCode !== "number" || (exitCode !== 0 && exitCode !== EXIT_CODE_ANNOTATIONS)) {
			return { approved: false, annotations: `revdiff exited with code ${exitCode ?? "unknown"}` };
		}

		if (!rawOutput) {
			return { approved: true, annotations: "" };
		}
		return { approved: false, annotations: rawOutput };
	}

	// ── plan_submit tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit your plan file for user review. " +
			"Call this only while plan mode is active, after writing your plan as a markdown file inside the working directory. " +
			"Pass the path to the plan file (e.g. PLAN.md or plans/feature.md). " +
			"The user reviews the plan in revdiff and can approve (quit clean) or annotate lines with feedback. " +
			"If feedback is returned, revise the plan in-place and call plan_submit again.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (phase !== "planning") {
				return toolText("Error: Not in plan mode. Use /plan to enter planning mode first.");
			}

			const inputPath = (params as { filePath?: string })?.filePath?.trim() ?? "";
			if (!inputPath) {
				return toolText(`Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument (e.g. "PLAN.md").`);
			}

			if (!isPlanPathAllowed(inputPath, ctx.cwd)) {
				return toolText(
					`Error: plan file must be a .md or .mdx file inside the working directory. Rejected: ${inputPath}`,
				);
			}

			const fullPath = path.resolve(ctx.cwd, inputPath);

			try {
				if (!statSync(fullPath).isFile()) {
					return toolText(`Error: ${inputPath} is not a regular file. Write your plan first.`);
				}
			} catch {
				return toolText(`Error: ${inputPath} does not exist. Write your plan using the write tool first.`);
			}

			const planContent = readFileSync(fullPath, "utf8");
			if (!planContent.trim()) {
				return toolText(`Error: ${inputPath} is empty. Write your plan first.`);
			}

			if (!ctx.hasUI) {
				// No interactive UI — auto-approve
				lastSubmittedPath = inputPath;
				checklistItems = parseChecklist(planContent);
				phase = "executing";
				pi.setActiveTools(savedTools.length > 0 ? savedTools : pi.getActiveTools().filter((t) => t !== PLAN_SUBMIT_TOOL));
				pi.appendEntry(EXECUTE_ENTRY_TYPE, { lastSubmittedPath });
				persistState();
				justApprovedPlan = true;
				updateStatus(ctx);
				updateWidget(ctx);
				return {
					content: [{ type: "text" as const, text: buildApprovedPrompt(inputPath) }],
					details: { approved: true },
					terminate: true,
				};
			}

			const { approved, annotations } = await reviewPlanWithRevdiff(ctx, fullPath);

			if (approved) {
				lastSubmittedPath = inputPath;
				checklistItems = parseChecklist(planContent);
				phase = "executing";
				pi.setActiveTools(savedTools.length > 0 ? savedTools : pi.getActiveTools().filter((t) => t !== PLAN_SUBMIT_TOOL));
				pi.appendEntry(EXECUTE_ENTRY_TYPE, { lastSubmittedPath });
				persistState();
				justApprovedPlan = true;
				updateStatus(ctx);
				updateWidget(ctx);
				return {
					content: [{ type: "text" as const, text: buildApprovedPrompt(inputPath) }],
					details: { approved: true },
					terminate: true,
				};
			}

			// Feedback — stay in planning
			return {
				content: [
					{
						type: "text" as const,
						text: buildDeniedPrompt(inputPath, annotations),
					},
				],
				details: { approved: false },
			};
		},
	});

	// ── Event hooks ───────────────────────────────────────────────────────

	// Gate writes during planning to markdown files only
	pi.on("tool_call", async (event, ctx) => {
		if (phase !== "planning") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const inputPath = (event.input as { path?: string }).path;
		if (!inputPath || !isPlanPathAllowed(inputPath, ctx.cwd)) {
			const verb = event.toolName === "write" ? "writes" : "edits";
			return {
				block: true,
				reason: `revdiff-plan: during planning, ${verb} are limited to .md/.mdx files inside the working directory. Blocked: ${inputPath ?? "(no path)"}`,
			};
		}
	});

	// Inject system prompt per phase
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (phase === "planning") {
			return { systemPrompt: PLANNING_PROMPT };
		}
		if (phase === "executing" && checklistItems.length > 0) {
			const remaining = checklistItems
				.map((t, i) => ({ t, i }))
				.filter(({ t }) => !t.completed)
				.map(({ t, i }) => `- [ ] [DONE:${i}] ${t.text}`)
				.join("\n");
			return {
				systemPrompt: `[EXECUTING]\nRemaining steps — mark each done with [DONE:N] in your response when completed:\n${remaining}`,
			};
		}
	});

	// Track checklist progress via [DONE:n] markers
	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "executing" || checklistItems.length === 0) return;
		const text = getAssistantText(event.message);
		if (!text) return;
		if (markCompletedSteps(text, checklistItems) > 0) {
			updateStatus(ctx);
			updateWidget(ctx);
		}
		persistState();
	});

	// Detect plan completion: all items done
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "executing" && justApprovedPlan) {
			justApprovedPlan = false;
			setTimeout(() => pi.sendUserMessage("Continue with the approved plan."), 0);
			return;
		}

		if (phase !== "executing" || checklistItems.length === 0) return;
		if (!checklistItems.every((t) => t.completed)) return;

		const completedList = checklistItems.map((t) => `- [x] ~~${t.text}~~`).join("\n");
		pi.sendMessage(
			{
				customType: "revdiff-plan-complete",
				content: `**Plan Complete!** ✓\n\n${completedList}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		phase = "idle";
		checklistItems = [];
		lastSubmittedPath = null;
		pi.setActiveTools(savedTools.length > 0 ? savedTools : pi.getActiveTools());
		savedTools = [];
		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	});

	// Restore persisted state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true && phase === "idle") {
			enterPlanning(ctx);
			return;
		}
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	function restoreState(ctx: ExtensionContext): void {
		let restored: PersistedState | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				(entry as { type: string }).type === "custom" &&
				(entry as { customType?: string }).customType === STATE_ENTRY_TYPE
			) {
				const data = (entry as { data?: unknown }).data;
				if (isPersistedState(data)) restored = data;
				if (isClearedState(data)) restored = undefined;
			}
		}

		if (!restored) {
			// Ensure plan_submit is not in tool list on fresh sessions
			pi.setActiveTools(pi.getActiveTools().filter((t) => t !== PLAN_SUBMIT_TOOL));
			return;
		}

		phase = restored.phase;
		lastSubmittedPath = restored.lastSubmittedPath;
		savedTools = restored.savedTools;

		if (phase === "executing") {
			// Re-load checklist from disk + scan session messages for [DONE:n]
			if (lastSubmittedPath && existsSync(path.resolve(ctx.cwd, lastSubmittedPath))) {
				const content = readFileSync(path.resolve(ctx.cwd, lastSubmittedPath), "utf8");
				checklistItems = parseChecklist(content);

				// Find execute marker, then scan subsequent messages
				let execIdx = -1;
				const entries = ctx.sessionManager.getBranch();
				for (let i = entries.length - 1; i >= 0; i--) {
					if (
						(entries[i] as { type: string }).type === "custom" &&
						(entries[i] as { customType?: string }).customType === EXECUTE_ENTRY_TYPE
					) {
						execIdx = i;
						break;
					}
				}
				for (let i = execIdx + 1; i < entries.length; i++) {
					const e = entries[i] as { type: string; message?: unknown };
					if (e.type === "message" && e.message) {
						const text = getAssistantText(e.message);
						if (text) markCompletedSteps(text, checklistItems);
					}
				}
			} else {
				// Plan file gone, fall back to idle
				phase = "idle";
				lastSubmittedPath = null;
			}
		}

		if (phase === "planning") {
			pi.setActiveTools([...new Set([...pi.getActiveTools().filter((t) => t !== PLAN_SUBMIT_TOOL), ...savedTools, PLAN_SUBMIT_TOOL])]);
		}

		updateStatus(ctx);
		updateWidget(ctx);
	}

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Toggle plan mode (planning → executing → idle)",
		handler: async (_args, ctx) => {
			togglePlanMode(ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan mode phase and progress",
		handler: async (_args, ctx) => {
			const parts = [`Phase: ${phase}`];
			if (lastSubmittedPath) parts.push(`Plan file: ${lastSubmittedPath}`);
			if (checklistItems.length > 0) {
				const done = checklistItems.filter((t) => t.completed).length;
				parts.push(`Progress: ${done}/${checklistItems.length} steps`);
				const remaining = checklistItems.filter((t) => !t.completed);
				if (remaining.length > 0) {
					parts.push("Remaining:", ...remaining.map((t) => `  ☐ ${t.text}`));
				}
			}
			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	// ── Flag ──────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode",
		type: "boolean",
		default: false,
	});
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isPersistedState(data: unknown): data is PersistedState {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as PersistedState).phase === "string" &&
		Array.isArray((data as PersistedState).savedTools)
	);
}

function isClearedState(data: unknown): data is ClearedState {
	return typeof data === "object" && data !== null && (data as ClearedState).cleared === true;
}

// ── Prompt strings ────────────────────────────────────────────────────────────

function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

function buildApprovedPrompt(filePath: string): string {
	return [
		`Plan approved! The user reviewed "${filePath}" and accepted it.`,
		"You are now in execution mode with full tool access.",
		"Work through the plan steps in order. After completing each step, include [DONE:N] in your response (where N is the step's zero-based index) so progress is tracked.",
		"When all steps are complete, you're done.",
	].join("\n\n");
}

function buildDeniedPrompt(filePath: string, annotations: string): string {
	return [
		`The user reviewed "${filePath}" and left the following feedback:`,
		annotations,
		`Please revise the plan file at "${filePath}" to address this feedback, then call ${PLAN_SUBMIT_TOOL} again.`,
	].join("\n\n");
}

const PLANNING_PROMPT = `[PLAN MODE]
You are in plan mode. You MUST NOT make any changes to the codebase — no edits, commits, installs, or destructive commands. During planning you may only write or edit markdown files (.md, .mdx) inside the working directory.

## Your goal

Explore the codebase, understand the task, write a plan file, then call plan_submit to submit it for review.

## Plan file structure

Use a clear markdown file (e.g. PLAN.md) with:
- **Context** — what problem this solves
- **Approach** — your recommended approach
- **Files to modify** — key paths that will change
- **Steps** — implementation checklist:
  - [ ] Step description
- **Verification** — how to test the changes

## Workflow

1. Explore with read, bash, grep, find, ls — understand what exists before proposing
2. Write a skeleton plan early, refine as you learn more
3. Ask the user if you hit ambiguities only they can answer
4. Call plan_submit when the plan is ready

Keep it concise. Use write for the first draft, edit for all revisions.`;
