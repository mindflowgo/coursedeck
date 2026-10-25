# CourseDeck iOS — Handoff (authoritative state)

Read this first, then [`PLAN.md`](./PLAN.md). `PLAN.md` is the implementation contract. [`PLAN-REVIEW.md`](./PLAN-REVIEW.md) is the historical review record and is partially superseded by the latest scope decisions.

## 1. Current state

- Branch: `ios-app` (based on `main`, pushed to `origin`).
- Folder: `ios-app/`.
- Plan: `ios-app/PLAN.md` (~915 lines, five review rounds applied).
- Review history: `ios-app/PLAN-REVIEW.md`.
- Conversation log: `ios-app/CONVERSATION-LOG.md`.
- No app code has been written yet. No commits have been made for `ios-app/` beyond the branch creation.
- Implementation is intended to be manifested via a workflow in this conversation, then continued in a fresh conversation if needed.

## 2. Latest user scope (authoritative)

- **Native SwiftUI/UIKit iPad app. No WKWebView, no JavaScript runtime, no local HTTP server, no sidecar.**
- **Keep the current Xcode/toolchain. Do not upgrade Xcode and do not modify the macOS builder container.**
  - Current toolchain measured from the existing IPAs: **Xcode 16.0, iOS 18.0 SDK**.
  - Deployment target: **iPadOS 18.0** (runs on 18.7 devices). No iOS 18.7/26-only APIs.
- **PDF export: out of scope.**
- **Scheduling: out of scope** — no generation, mark-done, Google Calendar, or ARC. Existing `course.schedule.md` is preserved and rendered as generic read-only Markdown.
- **MCP: out of scope** (HTTP and stdio).
- **SMTP/teacher email: out of scope.**
- **Ask-AI creation/deletion: out of scope.** Existing `[!USERNOTE]` blocks must render read-only and must be protected from every overwrite path.
- **Chemical/mhchem rendering: future work.** SwiftMath fallback now; renderer protocol must allow mhchem/KaTeX later.
- **Complex tables/ledgers are essential.** Must preserve all cells, currency, alignment, multiline cells, stacked tables, no-outer-pipe tables, and pipes inside math/image specs.
- **All DeepSeek-powered tests/prompts must work**, including lesson tests, course tests, unit tests, pop quizzes, custom tabs, and prompt provenance.
- Sideload via **iLoader** (unsigned IPA; iLoader signs with the user's Apple ID).
- Implementation preference: a **workflow** in this conversation, after plan polishing.

## 3. Environment facts

- Builder: `C:\macos-builder` — `dockurr/macos` container, `VERSION: "15"`, 10 GB RAM, 4 cores, 64 GB disk, SSH `127.0.0.1:2222`, user `builder` / password `builder`.
- Existing build pattern: `build-itube.ps1` / `build-ipadmonitor.ps1` (rsync → xcodegen → xcodebuild unsigned archive → `Payload/*.app` → zip IPA → scp back).
- Existing IPAs: `C:\macos-builder\itube.ipa`, `iPadMonitor.ipa`; both use `DTSDKName=iphoneos18.0`.
- iLoader: `C:\Users\Meeoowz\Documents\Coding\ipad-monitorus-extendus\iloader` (nab138/iloader Tauri app; signs unsigned IPA with Apple ID; Developer Mode required; free account 7-day/3-app limit).
- The container is frozen. Do not install Xcode 26.3, resize the disk, or download simulator runtimes.
- Build gate: Core `swift test` + unsigned IPA install via iLoader. App/UI tests only if a simulator runtime already exists; otherwise manual device QA.

## 4. Real data and prompts

- Live desktop data: `C:\Users\Meeoowz\Documents\ILC\_ILC-APP-DATA`.
- 7 courses, 125 lesson files, 547 Markdown files, 542 MB total; `_backup/` ≈ 347 MB; default backup ≈ 196 MB.
- Known missing refs: 78 unique missing local files (65 `.xlsx`, 11 `.pdf`, 2 images) + 382 unique missing HTML attachment targets. Gate on “no new missing refs,” not zero.
- 13 existing pop-quiz files; one parses to 0 questions (table output) and must show a corrupt-quiz/regenerate error.
- Prompts root: `summary`, `cheatsheet`, `popquiz`, `unit_assignments`, `unit_test`, `course_summary`, `course_test`, `course_schedule`; **`test.md` and `course_cheatsheet.md` exist only in `prompts/backup/`**; `test_kica.md` absent.
- `prompts/backup/test.md` asks 6 MC + 4 FIB but its schema shows 2+2. `course_test.md` asks 12 MC + 4 multi-part but schema shows 2+2. The plan requires editing the staged prompts/schemas and enforcing the same counts.
- `llm_config.json`: active card `Deepseek`, provider `openai_compatible`, baseUrl `https://api.deepseek.com`, model `deepseek-flash`, **`authHeaderType: "api_key"`** (DeepSeek requires Bearer; normalize/test), `timeoutSeconds: 150`. A GLM card exists (`https://opencode.ai/inference/openai/v1/`, `glm-5.3-flash`, Bearer).
- Do not print or commit API keys. Migrate imported keys to Keychain in Phase 1; omit `llm_config.json` from iOS exports; export `llm_ios.json` without keys.

## 5. Architecture and stack

- `CourseDeck` app target: SwiftUI shell + UIKit reader/editor; `NavigationSplitView`; multi-scene; Pencil/keyboard; Files import/export.
- `CourseDeckCore` local Swift package: Foundation-only; models, storage, markdown, AI, ingestion; testable with `swift test`.
- Dependencies (exact versions, pins in `project.yml`/`Package.swift`):
  - `swift-markdown` **0.7.1** + `swift-cmark` **0.7.0 exact**
  - `SwiftSoup` **2.14.3**
  - `SwiftMath` **1.7.3**
  - `ZIPFoundation` **0.9.20**
  - `Yams` **6.2.2**
  - `SwiftDraw` **0.24.0**
- Package manifest: `// swift-tools-version: 6.0`, `platforms: [.iOS("18.0"), .macOS("14.0")]`, `swiftLanguageModes: [.v5]`; app `SWIFT_VERSION = 5.0`.
- Commit both `ios-app/Package.resolved` and `ios-app/CourseDeckCore/Package.resolved`; copy the app resolved file into the generated workspace before `xcodebuild`.
- Data root: `Library/Application Support/CourseDeck` (not Documents). Only `Documents/Import Inbox` and `Documents/Export` are user-visible. Audit the **entire Documents tree** on activation.
- Reader: block model with prose runs, tables, images, math, callouts, details, USERNOTE, code blocks, task lists, thematic breaks.
- Table layout: **fixed-height viewport + inner scroll + full-screen table** (option b), persisted offsets, gesture handoff, VoiceOver table semantics.
- Editor: plain monospaced `UITextView`; no live preview; smart quotes/dashes/autocorrect disabled; autosave 2–5 s + save on background/disappear; coordinated compare-and-swap with `.bak`.
- AI: OpenAI-compatible client; DeepSeek `deepseek-flash`, Bearer, `max_tokens` 16K–32K, thinking disabled by default, SSE, only `[DONE]`/`stop` success, durable queue with full inputs, foreground-only, no false resume.
- Backups: ZIPFoundation streaming; allowlist/denylist; skip/quarantine denylisted entries; no `llm_config.json` export; merge-by-default with conflict copies; 3–4× free space; no encryption in v1.

## 6. Plan phases

0. Toolchain/sideload smoke: current Xcode 16.0/iOS 18.0, XcodeGen scheme, six packages, unsigned IPA, IPA metadata `iphoneos18.0`/`MinimumOSVersion 18.0`, iLoader install, Keychain/Files, reader prototype.
1. Data safety + reader: Application Support root, Import Inbox audit, dataVersion, backup merge/restore, key migration, checkpoint dual fields, course/unit navigation, markdown pipeline, complex tables, math, images/SVG, callouts/details/USERNOTE, real-data import.
2. Editing + prompts: plain editor, autosave/conflict, custom tabs, prompt manager/provenance, prompt staging/overrides.
3. AI generation: provider store/Keychain, DeepSeek client, durable queue, lesson/unit tabs, course docs, aggregation, missing-work scan, output validation.
4. Quizzes: parser (including legacy FIB/multiple answer sections), practice/unit/pop quiz UI, AI grading/partial credit, durable drafts, attempt history.
5. Ingestion: zip/MHTML/HTML, `_backup` archiving, image optimization, SVG conversion, manifest merge, desktop compatibility patch.
6. Hardening: edge cases, performance, accessibility, diagnostics, data version/migration, device QA, re-sign/backup drill.

## 7. Known decisions / defaults

- Course docs use the **budgeted curated aggregation** (3,000/2,500/2,200 chars per lesson); this intentionally diverges from desktop’s unbudgeted default. Raw-lessons generation is not exposed for course docs in v1.
- Unit tabs budget **3,000 chars/lesson, 80,000 total**, curated → raw fallback.
- Generated course test: **12 MC + 4 multi-part (16 total)**. 10/24-MC variants are read-only parser fixtures.
- `course.lesson` is the virtual Course Navigation page, not the notes aggregate; no generation CTA, no new checkpoints, preserve existing `course.lesson.md` checkpoint `file` strings.
- `course.cheatsheet` is exposed as an always-valid course tab on iOS (desktop hides it).
- Bulk missing-work scan: summary + cheatsheet only.
- Archive-only course deletion in v1.
- Multi-model cards: DeepSeek + GLM, active selector; only OpenAI-compatible transport.
- Table-cell editing: not in v1; edit raw Markdown. Task-list toggles disabled on schedule/read-only documents.
- No simulator runtime download; Core `swift test` + manual device QA is the approved gate.

## 8. Open low-severity items (do not block implementation)

- Fix the drift in fixture references in the plan checklist (MathML `01.03`/`01.06`/`04.09`; add GWL3O/MCR3U 12+4 and CLU3M 6+4 fixtures).
- Ensure the required-prompt manifest marks `lesson`/`test_kica` as protected-if-present but not required.
- Clarify `_backup/` device-backup exclusion (now documented).
- Verify `swift-cmark` exact 0.7.0 resolves with swift-markdown 0.7.1.
- Verify SwiftMath 1.7.3 `LayoutInfo` ascent/descent on the actual checked-out tag.
- 11 BAF3M SVGs are quoted-printable encoded (`=3D`); repair or placeholder.
- Exact app/UI test execution depends on an existing simulator runtime.

## 9. Final review workflow (not scheduled)

The recurring dispatcher automation was **removed at the user's request**. There is currently no scheduled task that will start the final review.

The final review design and script remain available for a manual run:

- **Implementation run:** `dwfrun-a7fb3be5-7562-4cce-8d7a-c051fa9b735d`.
- **Final review script:** `ios-app/.zcode/workflow-drafts/final-review.dwf.ts`.
- **Final review spec:** `ios-app/FINAL-REVIEW-WORKFLOW.md`.
- To run it manually after the implementation is terminal: `CreateWorkflow` with name "CourseDeck final review" and `path: "ios-app/.zcode/workflow-drafts/final-review.dwf.ts"`.
- The final review runs six section reviewers in parallel, dispatches disjoint-ownership fixers, routes out-of-scope requests to a final coder, runs a thorough final review, applies one final fixer, then runs the Core test and IPA build gates.

## 10. Next action

Read `PLAN.md`, then start Phase 0 exactly as written. Do not upgrade Xcode, resize the builder, add PDF/scheduling, or reintroduce a WebView. The workflow should implement in phase order, run `swift test` after each core subsystem, and stop at the Phase 0 IPA/iLoader gate before feature work.
