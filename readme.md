# Plan: revdiff-plan — Plan Mode for Pi Using revdiff

## What this is

A pi extension that gives the agent a planning mode (idle → planning → executing → idle) identical to plannotator's — but instead of opening a browser for plan review, it opens the plan file in **revdiff** (`--only=<plan.md>`). The user annotates specific lines in the TUI; no annotations = approved, annotations = feedback → agent revises and resubmits.

Zero browser dependency. Single-file extension. Leverages the existing revdiff pi integration for the actual TUI launch.

---

## How it works end-to-end

```
User: /plan
→ enter planning phase
→ agent explores codebase, writes PLAN.md
→ agent calls plan_submit("PLAN.md")
→ revdiff opens: revdiff --only=PLAN.md
→ user annotates lines (or quits clean)
→ no annotations  → approved → transition to executing phase
→ has annotations → feedback injected into tool result → agent revises → loop
```

During **executing**: full tool access, checklist progress tracking via `[DONE:n]` markers.

---

## Architecture

### Files

```
revdiff-plan/
  index.ts       - single extension file, ~350 lines
  package.json   - pi extension package
  tsconfig.json
```

### State machine

```
type Phase = "idle" | "planning" | "executing"
```

Persisted via `pi.appendEntry` (same pattern as plannotator + revdiff.ts).

### Core pieces

**1. `plan_submit` tool**
- Only callable in planning phase (guard check)
- Validates: path must be `.md`/`.mdx` inside cwd, file must exist and be non-empty
- Launches revdiff via `ctx.ui.custom` (direct mode, same as revdiff.ts `runDirectReview`)
- Command: `revdiff --only=<path> --output=<tmpfile>`
- Reads `tmpfile` for annotations
- No annotations → return approve result + `terminate: true`, transition to executing
- Has annotations → return deny result with annotations as text, stay in planning

**2. Write gate via `pi.on("tool_call")`**
- During planning: block `write`/`edit` calls to non-markdown paths (same logic as plannotator)

**3. System prompt via `pi.on("before_agent_start")`**
- planning phase → inject planning instructions (explore, write plan, submit for review)
- executing phase → inject checklist reminder with remaining steps

**4. Commands**
- `/plan` — toggle planning mode on/off
- `/plan-status` — show current phase, plan file, and checklist progress

**5. Flag**
- `--plan` — start pi in planning mode

**6. Checklist tracking**
- Simple regex parse of `- [ ]` / `- [x]` / `- [DONE:n]` from plan file
- Re-read from disk each turn during executing

---

## Key differences from plannotator

| Plannotator | revdiff-plan |
|---|---|
| Browser UI (HTML assets) | revdiff TUI (`--only` mode) |
| `plannotator_submit_plan` tool | `plan_submit` tool |
| 3-layer config system | No config (YAGNI) |
| Phase model/thinking overrides | No model changes (YAGNI) |
| `/plannotator`, `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`, `/plannotator-archive` | `/plan`, `/plan-status` only |
| ~1300 lines | ~350 lines |

---

## Implementation details

### revdiff launch (plan review)

Reuse the same `spawnSync` + `ctx.ui.custom` pattern from revdiff.ts `runDirectReview`:

```ts
const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
  tui.stop();
  process.stdout.write("\x1b[2J\x1b[H");
  const result = spawnSync(revdiffBin, ["--only", planPath, `--output=${outputFile}`], {
    cwd: process.cwd(),
    env: { ...process.env, REVDIFF_EXIT_CODE_ON_ANNOTATIONS: "true" },
    stdio: "inherit",
  });
  tui.start();
  tui.requestRender(true);
  done(result.status ?? 1);
  return { render: () => [], invalidate() {} };
});
```

Exit 0 or 10 = success. Read `outputFile` for annotations.

### Annotation → feedback

Convert annotation output to a human-readable block returned in the `plan_submit` tool result:

```
The user reviewed your plan and left the following feedback:

## PLAN.md:12 (+)
This step is missing error handling for the DB connection failure case

## PLAN.md:34 (file-level)
Add a section on rollback strategy

Please revise the plan and call plan_submit again.
```

### Checklist parsing

```ts
function parseChecklist(markdown: string): ChecklistItem[] {
  return markdown
    .split("\n")
    .flatMap((line, i) => {
      const m = /^\s*-\s+\[([ xX]|DONE:\d+)\]\s+(.+)$/.exec(line);
      if (!m) return [];
      return [{ index: i, done: m[1] !== " ", text: m[2] }];
    });
}
```

### Session restore

On `session_start` / `session_tree`, replay `appendEntry` records to restore phase + last submitted path (same as revdiff.ts `restoreState`).

---

## What we explicitly skip (YAGNI)

- Model/thinking level changes per phase
- Config file layering
- Plan diff (showing what changed between submissions)
- Archive browser
- `/plan-annotate` / `/plan-last` commands
- Event bus for other extensions to hook into
- Overlay mode (direct only — revdiff.ts shows it's sufficient)

---

## Success criteria

1. `/plan` enters planning mode; agent can only write `.md` files
2. Agent writes a plan file and calls `plan_submit("PLAN.md")`
3. revdiff opens with the plan file in `--only` mode
4. Quit with no annotations → approved, phase transitions to executing, full tools available
5. Quit with annotations → feedback returned to agent, stays in planning
6. Agent completes steps with `[DONE:n]` markers; status shows progress
7. `/plan` again exits executing → idle, restores original tool set
8. Session restore works: phase/plan path survive session restart

---

## Files to create

- `revdiff-plan/index.ts` — the extension (~350 lines)
- `revdiff-plan/package.json`
- `revdiff-plan/tsconfig.json`

---

## Steps

- [x] Write `package.json` and `tsconfig.json`
- [x] Implement state machine + persistence (`Phase` type, `appendEntry`, `session_start` restore)
- [x] Implement `plan_submit` tool with revdiff launch
- [x] Implement write gate (`tool_call` event)
- [x] Implement system prompt injection (`before_agent_start` event)
- [x] Implement `/plan` command (toggle + optional path arg)
- [x] Implement `/plan-status` command
- [x] Implement `--plan` flag
- [x] Wire checklist tracking during executing phase
- [ ] Manual smoke test: enter plan mode, write plan, submit, annotate, revise, approve, execute

## Verification

```bash
cd /some/git/repo
pi -e /path/to/revdiff-plan
# Enter plan mode
/plan
# Agent writes PLAN.md and calls plan_submit
# Revdiff opens — annotate a line, quit
# Agent sees feedback, revises, resubmits
# Quit with no annotations → executing phase
# /plan-status shows progress
# /plan again → back to idle
```
