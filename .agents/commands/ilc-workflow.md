---
description: Run the ilc-study-tool change workflow (analyze, plan, plan-check, execute, build-verify, code-review).
argument-hint: "[feature or bug to implement]"
skills: ilc-workflow
---

Use the `ilc-workflow` skill for this request:

$ARGUMENTS

Follow the skill's phases in order within this single turn: read the relevant `docs/` rules and match existing conventions, analyze the related files, write a plan, sanity-check the plan with the `light-plan-passthrough` subagent, execute the changes, verify the build (`bun run check` and `bun --cwd app build`), then run the `code-reviewer` subagent to independently confirm the code is functional and not overly complicated. Code with consistent variables and naming throughout. Finish with a concise summary of what changed and the build/review status.
