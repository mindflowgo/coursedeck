# CourseDeck iOS — Final Review & Fix Workflow

This is the scheduled post-implementation workflow. It must start **only after** the implementation workflow `dwfrun-a7fb3be5-7562-4cce-8d7a-c051fa9b735d` is terminal (`completed`, `errored`, or `stopped`). It is dispatched by the scheduled automation, not by the implementation workflow.

## 1. Reviewers (parallel, read-only)

All reviewers run at once, each with a fresh context. They read `ios-app/PLAN.md`, `ios-app/HANDOFF.md`, and their assigned section deeply; they may research external docs and run read-only checks. They do not edit.

| Reviewer | Scope | Required evidence |
|---|---|---|
| Build & reproducibility | `project.yml`, `CourseDeckCore/Package.swift`, `Package.resolved` (both), `scripts/**`, `Info.plist`, `PrivacyInfo.xcprivacy`, `Assets.xcassets`, XcodeGen scheme, IPA metadata | Exact pins, tools/platform declarations, scheme, build script, unsigned IPA path, iLoader constraints |
| Data, storage & security | Models, path/ID validation, atomic file store, repositories, prompts, checkpoints, `dataVersion.json`, backup/import/export, Keychain, import-inbox audit, job journal | Schema roundtrip, unknown-field preservation, secret scanning, merge policies, corruption/forward-version behavior, USERNOTE overwrite protection |
| Markdown, tables, math & ingestion | Markdown pipeline, table repair/parser, cell inline AST, math/currency heuristics, image specs, callouts/details/USERNOTE, MathML, block model, SwiftSoup/MHTML/ZIP, HTML→Markdown, image optimizer, SVG | Table corpus, live fixture counts, table pipe/code/math cases, MathML text preservation, ingestion collisions, `_backup` archiving |
| Reader, UI & rendering | Reader view, grouped prose, table grid (option b), images/SVG, math attachments, callouts/details, USERNOTE cards, code blocks/task lists, document viewer, checkpoint UI, accessibility/performance | Table viewport/gesture/offsets, Dynamic Type, VoiceOver, selection/copy, large-lesson performance, no WebView |
| AI, queue, prompts & quizzes | Provider store/Keychain, DeepSeek client/SSE, queue, prompt catalog/aggregation, output validation, question parser (legacy FIB/multiple answers), grading, pop quizzes, editor/navigation | Bearer auth, `deepseek-flash`, max_tokens/thinking, `[DONE]`/stop-only success, 150s mapping, queue resume, live quiz fixtures, 12+4 course test |
| Cross-cutting & real data | Tests, fixtures, data compatibility, privacy, performance, build/sideload, edge cases across modules | 542 MB/125-lesson scale, 78+382 missing refs baseline, 13 pop quizzes, iLoader re-sign, no PDF/scheduling/MCP/SMTP/Ask-AI |

Each reviewer returns findings with `area`, `where`, `what`, `evidence`, `severity`, and a suggested `fix`. Findings are deduplicated by `where` + `what` before dispatch.

## 2. Fixers (parallel, disjoint ownership)

Multiple reviewers may feed the same fixer. Fixers run in parallel. Each fixer may edit **only** its listed paths. If a fix requires anything outside, it must **not** edit it; it returns a `RequestedChange` with `where`, `what`, `why`, and related findings.

| Fixer | Findings group | Editable paths only |
|---|---|---|
| `build-fixer` | Build/config/resources/scripts | `ios-app/project.yml`, `ios-app/CourseDeckCore/Package.swift`, both `Package.resolved`, `ios-app/scripts/**`, `ios-app/CourseDeck/Resources/Info.plist`, `PrivacyInfo.xcprivacy`, `Assets.xcassets/**` |
| `data-fixer` | Data/storage/security | Core models/paths/storage/repositories/backup/security/settings/jobs; `CourseDeck/Services/**` storage/keychain only |
| `markdown-fixer` | Markdown/tables/math/ingestion | Core `Markdown/**`, `Ingestion/**`, image/SVG pipeline; no UI |
| `reader-fixer` | Reader/UI/rendering | `CourseDeck/Render/**`, reader-specific `CourseDeck/UI/**`, `CourseDeck/App/Reader*`, table/document/checkpoint views |
| `ai-quiz-fixer` | AI/queue/prompts/quizzes/editor | Core `AI/**`, `Quizzes/**`; `CourseDeck/Editor/**`, quiz/prompt UI |
| `tests-fixer` | Tests/fixtures | `CourseDeckCore/Tests/**`, `CourseDeckTests/**`, `CourseDeckUITests/**`, `**/Fixtures/**` |

Rules for every fixer:

- Read the plan and the findings first; reproduce before changing.
- Stay inside the editable set. Never touch another fixer's files.
- Do not change public contracts, shared types, or build settings outside the scope; return a `RequestedChange`.
- Do not run destructive commands, do not commit, do not upgrade Xcode or modify the builder container.
- Run the tests available in your scope; report what actually ran.
- Return `FixReport` with changed files, addressed finding IDs, requested changes, checks, and unresolved items.

## 3. Final coder (single, cross-cutting)

Receives all fixer reports, all `RequestedChange`s, and the original findings. It:

- researches the relevant code before changing it;
- assesses whether multiple requested changes interfere;
- decides the implementation order and applies cross-cutting/shared-file changes itself;
- may edit shared files and any file needed to resolve a requested change, but must not silently overwrite a fixer's work without evaluating it;
- may reject a requested change with a reason;
- runs the available tests/checks;
- returns `FinalCoderReport` with files changed, decisions, checks, and unresolved items.

## 4. Thorough final review (single, read-only)

A fresh reviewer reads the whole app, the plan, the fixer reports, and the final coder report. It looks for medium/large flaws, regressions, data loss, security issues, and plan violations. It returns `FinalReviewReport` with `approved` and findings.

## 5. Final fixer (single)

Fixes only the findings from the thorough final review. It may edit any file needed, but must not add features or re-open settled scope. It runs the available checks and returns a `FinalFixReport`.

## 6. Gate and report

- Run `ios-app/scripts/run-core-tests.ps1` if present (Core `swift test`).
- Run `ios-app/scripts/build-ipa.ps1` if present (unsigned IPA).
- If the builder is unavailable, record `notCovered`; do not claim the build passed.
- Publish a markdown report with reviewer/fixer outcomes, final review findings, gate results, and remaining risks.
- Return the standard `WorkflowReport` shape.
