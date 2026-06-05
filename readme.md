# pi-revdiff-plan

Plan-first workflow for [Pi](https://github.com/earendil-works/pi-coding-agent) using [revdiff](https://github.com/umputun/revdiff) for interactive markdown plan review.

## What it does

This extension adds a lightweight state machine to Pi:

- `idle` → normal Pi behavior
- `planning` → the agent can explore, but may only write/edit markdown plan files
- `executing` → after plan approval, full tools are restored and checklist progress is tracked

The review loop is simple:

1. Start plan mode with `/plan`
2. Let the agent explore and write a markdown plan
3. The agent calls `plan_submit("PLAN.md")`
4. `revdiff` opens for review
5. If you quit with no annotations, the plan is approved
6. If you annotate lines, the feedback goes back to the agent for revision
7. Once approved, execution starts and checklist progress is tracked via `[DONE:n]`

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ recommended
- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
- [revdiff](https://github.com/umputun/revdiff) available in `PATH`
  - macOS/Homebrew example:
    ```bash
    brew install umputun/apps/revdiff
    ```
- A terminal environment where Pi can launch TUI tools

## Install

```bash
pi install pi-revdiff-plan
```

Then verify:

```bash
pi list
```

### From source

```bash
git clone <this-repo>
cd pi-revdiff-plan
pi install .
```

## Usage

### Start in normal mode

```bash
pi
```

### Start directly in plan mode

```bash
pi --plan
```

### Typical session

```text
/plan
# agent explores codebase and writes PLAN.md
# agent calls plan_submit("PLAN.md")
# revdiff opens for review
# annotate and quit, or quit clean to approve
```

After approval, the extension restores the previously active tool set and tracks progress using checklist items parsed from the approved markdown file.

## Commands

### `/plan`

Toggles plan mode when safe:

- `idle` → `planning`
- `planning` → `idle`
- during `executing`, it does not abort silently; it warns you to use `/plan-abort`

### `/plan-abort`

Cancels the current execution phase and returns to idle mode.

### `/plan-status`

Shows:

- current phase
- current plan file, if any
- checklist progress
- remaining unchecked steps

## Flags

### `--plan`

Starts Pi with plan mode enabled.

Example:

```bash
pi --plan
```

## Keyword trigger

Plan mode also activates automatically when you type a message containing one of these trigger words:

| Keyword | Example phrase |
|---------|---------------|
| `plan` | "let's plan this feature" |
| `design` | "design a new caching layer" |
| `spec` | "write a spec for the API" |
| `blueprint` | "blueprint the migration" |

The trigger only fires for **interactive** input (your keystrokes). Messages sent by extensions or RPC clients — including the internal `"Continue with the approved plan."` prompt — are ignored, so plan mode cannot be accidentally re-entered by the agent mid-session.

## How plan files should look

The agent is prompted to create a markdown plan with sections like:

- Context
- Approach
- Files to modify
- Steps
- Verification

Checklist items should be standard markdown task items, for example:

```md
- [ ] Add parser tests
- [ ] Refactor state restoration
- [ ] Update README
```

During execution, the extension tracks completion when the agent emits markers like:

```text
[DONE:0]
[DONE:1]
```

These markers should appear on their own lines.

## Validation commands

This project currently uses a minimal validation flow through npm scripts:

```bash
npm run typecheck
npm run build
npm run test
npm run lint
npm run validate
```

### Script details

- `typecheck` — run TypeScript with `--noEmit`
- `build` — compile project to `dist/`
- `test` — build and run Node test suites
- `lint` — currently aliases the type-safe validation baseline
- `validate` — run typecheck and tests together

## Troubleshooting

### `revdiff binary not found`

Make sure `revdiff` is installed and available in `PATH`.

You can verify with:

```bash
command -v revdiff
```

You can also point to a custom binary path with `REVDIFF_BIN`.

### Plan submit is rejected

The extension only allows plan files that:

- are inside the current working directory
- end with `.md` or `.mdx`
- exist and are not empty

Examples of rejected paths:

- `../PLAN.md`
- `/absolute/path/outside/repo.md`
- `plan.txt`

### The agent cannot edit source files in plan mode

That is expected. During planning, `write` and `edit` are restricted to markdown files only. Approve the plan first to restore full tool access.

### Progress did not update

Checklist progress only updates in executing mode and depends on `[DONE:n]` markers matching the zero-based checklist index.

### Restored session looks wrong

The extension restores plan state from Pi session history. If the approved plan file was deleted or moved, restore falls back to idle.

## CI and releases

Recommended repository improvements:

- CI to run type checking and tests on pushes and pull requests
- automated release/versioning flow for publishing

If those files exist in your fork, check `.github/workflows/`.

## Project structure

```text
index.ts                   # extension entrypoint — all logic lives here
test/keywords.test.ts      # keyword regex + source-filter integration tests
test/parsing.test.ts       # checklist parsing, path validation, getAssistantText
test/state.test.ts         # restoreState persistence tests
.pi/extensions/rtk.ts      # optional RTK bash rewrite helper
readme.md                  # this file
```

## License

MIT
