# pi-revdiff-plan

Plan-first workflow for [Pi](https://github.com/earendil-works/pi-coding-agent) using [revdiff](https://github.com/umputun/revdiff) for interactive markdown plan review.

## What it does

This extension adds a lightweight state machine to Pi:

- `idle` → normal Pi behavior
- `planning` → the agent can explore, but may only write/edit markdown plan files
- `executing` → after plan approval, full tools are restored and checklist progress is tracked

The review loop is simple:

1. Start plan mode with `/revdiff-plan-mode`
2. Let the agent explore and write a Markdown plan
3. The agent calls `revdiff_submit_plan("PLAN.md")`
4. `revdiff` opens for review
5. Quit with no annotations to approve, or annotate lines to request revisions
6. After approval, the agent executes the checklist; each completed step updates its checkbox in the submitted plan
7. When every checklist item is complete, the extension reports completion and returns to `idle`

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
pi --revdiff-plan
```

### Typical session

```text
/revdiff-plan-mode
# agent explores codebase and writes PLAN.md
# agent calls revdiff_submit_plan("PLAN.md")
# revdiff opens for review
# annotate and quit, or quit clean to approve
```

After approval, the extension restores the previously active tool set and adds `revdiff_mark_done`. The submitted plan is the progress record: completing a step updates its checkbox. When every checklist item is complete, the extension reports completion and returns to `idle` automatically.

## Commands

### `/revdiff-plan-mode`

Toggles plan mode when safe:

- `idle` → `planning`
- `planning` → `idle`
- during `executing` with an incomplete or empty checklist, it warns you to use `/revdiff-plan-abort`
- during `executing` with every checklist item complete, it returns to `idle`

### `/revdiff-plan-abort`

Cancels the current execution phase and returns to idle mode.

### `/revdiff-plan-status`

Shows:

- current phase
- current plan file, if any
- checklist progress
- remaining unchecked steps

## Flags

### `--revdiff-plan`

Starts Pi with plan mode enabled.

Example:

```bash
pi --revdiff-plan
```

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

During execution, the extension tracks completion by either of these mechanisms:

- The agent calls `revdiff_mark_done` with a zero-based checklist index.
- The agent emits a `[DONE:n]` marker in its response, where `n` is a zero-based checklist index.

For example:

```text
[DONE:0]
[DONE:1]
```

Markers are recognized anywhere outside fenced code blocks. Each completed item is written back to the submitted plan as `[x]`.

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

An absolute path is judged by containment, so one that points inside the working
directory (for example `/repo/PLAN.md` while working in `/repo`) is accepted.

### The review closed without a decision

If `revdiff` cannot launch, or exits with anything other than its clean-quit (`0`)
or annotations (`10`) codes, the plan is neither approved nor rejected. The agent
is told to call `revdiff_submit_plan` again rather than treating the failure as
plan feedback.

### The agent cannot edit source files in plan mode

That is expected. During planning, `write` and `edit` are restricted to markdown files only. Approve the plan first to restore full tool access.

### Progress did not update

Checklist progress only updates in executing mode. The agent should call `revdiff_mark_done` with a zero-based checklist index; `[DONE:n]` markers are also recognized as a fallback. Each completed item updates its matching checkbox in the submitted plan file. A plan without checklist items cannot complete automatically; use `/revdiff-plan-abort` to leave execution.

### Restored session looks wrong

The extension restores plan state from Pi session history. If the approved plan file was deleted or moved, restore falls back to idle.

## CI and releases

GitHub Actions runs type checking and tests on pushes and pull requests. Releases are published from GitHub.

## Project structure

```text
index.ts                # extension entrypoint and all extension logic
test/parsing.test.ts    # parsing, progress, path, and review-outcome tests
test/state.test.ts      # session-state restoration tests
.github/workflows/      # CI and release workflows
readme.md               # this file
```

## License

MIT
