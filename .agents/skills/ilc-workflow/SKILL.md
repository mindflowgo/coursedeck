---
name: ilc-workflow
description: The standard change workflow for the ilc-study-tool repo. Use whenever you are asked to add a feature, fix a bug, or otherwise modify code in this project. It enforces reading the repo's rules in docs/ first, planning before editing, having the plan sanity-checked by the light-plan-passthrough subagent, executing the change, verifying the build, and finally an independent code-reviewer audit. Prefer this over ad-hoc editing for any non-trivial change here.
---

# ilc-study-tool Change Workflow

This is the house workflow for changing code in `ilc-study-tool`. Run **all phases in a single turn** — do not stop between them to ask whether to continue.

Two standing rules apply to every change:

- **Follow the repo's own rules.** Before writing anything, read the relevant files under `docs/` (see the map below). The codebase has deliberate conventions (file layout, naming, parser/markdown pipelines, provider abstractions) and new code must match them rather than invent parallel patterns.
- **Use consistent variables and naming.** Reuse the existing names, types, and shapes for the same concept. Do not introduce a second variable for something that already has a canonical one in the surrounding code.

## Repo rules map (read what's relevant)

The `docs/` directory is the source of truth for how this project is built. Start with the ones that touch your change:

- `docs/architecture.md` — system architecture, directory map, feature contracts, and the AI-provider model section. This is the primary reference.
- `docs/editor.md` — CodeMirror 6 / live-preview editing conventions.
- `docs/pdf.feature.md` and `docs/pdf-performance.md` — the client-side PDF pipeline.
- `docs/rrule-deterministic-scheduling-plan.md` and `docs/rrule-review.md` — the scheduling design.
- `docs/improvements.md`, `docs/updates.md` — outstanding work and recent changes.

Also skim the code neighboring your target so the change looks native to it.

## The phases

Run these in order. Keep notes as you go so the later subagent briefs are concrete.

### 1. Analyze
Locate every file related to the feature or bug: the route/component that triggers it, the server/repository layer, the parser or provider code it flows through, and any tests or scripts that already cover the area. Understand the existing shape before proposing anything.

### 2. Plan
Write a short, concrete plan: which files change, what each change is, and why. Prefer adjusting existing structures over adding new ones.

### 3. Plan sanity check — `light-plan-passthrough` subagent
Launch a subagent of type `light-plan-passthrough` and hand it your plan plus the relevant file paths. Ask it to catch simple errors, wrong assumptions, missed files, and conventions you may have overlooked. Fold real findings into the plan before executing; this is a second pair of eyes, not a gate.

### 4. Execute
Make the changes. Match surrounding style and naming, keep the diff focused on the task, and do not refactor unrelated code.

### 5. Verify the build
Run the repo's checks and fix anything red — especially syntax/type errors introduced by the change:

```bash
bun run check          # app check + server tsc
bun --cwd app build    # frontend build
```

If the change touches an area with a dedicated script (parser, PDF, provider, sidecar), run that too — see `package.json` `test` for the list. Do not report the change as done while the build is broken.

### 6. Independent audit — `code-reviewer` subagent
When the change builds, launch a subagent of type `code-reviewer` for an independent audit. Instruct it to verify two things explicitly:

1. **Functional correctness** — the code actually does what the task requires and does not break existing callers.
2. **Not overly complicated** — the solution is no more elaborate than the problem demands; call out needless abstraction, duplicated logic, or config that could be simpler.

Apply the reviewer's actionable findings, then summarize the final state of the change.

## Output

End the turn with a concise summary: what changed and where, what the plan review and code review surfaced, and the build/test status.
