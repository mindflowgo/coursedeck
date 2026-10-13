# Plan & Implementation Updates: Course-Wide Test Generation

## Overview
When generating a course-wide practice test (via "Complete Course" scope -> Practice Test -> "Apply & Re-generate"), generation failed due to several architectural bottlenecks:
1. **Aggregator Dependency Flaw**: `CourseService.buildAggregatedPayload(courseId, 'test')` exclusively searched for lesson practice tests (`*.test.md`). If individual lesson tests hadn't already been generated for the entire course, the payload was empty, throwing an immediate HTTP 400 error.
2. **Context Bloat & Payload Sourcing**: Course synthesis should not pass raw uncurated course materials (`.lesson.md`). Instead, it must utilize the already curated lesson study materials (`.summary`, `.cheatsheet`, and any existing `.test.md`), budgeted to fit model context limits.
3. **LLM Request Timeout**: Synthesizing 12 KICA MCQs + 4 multi-part case problems across 4+ units often exceeded the hardcoded 90-second timeout in `LLMService.generateResult`.
4. **UI Versioning Disconnect**: `PromptCard` offered an invalid "Save as New Version" modal choice for course-wide documents, which do not support multi-file versioning.
5. **Prompt Frontmatter Tracking Bug**: When a user modified the prompt instructions (e.g. changing 12 questions to 24 questions), the generated file had 24 questions, but the YAML frontmatter at the top of `course.test.md` reverted to the original 12 questions. This occurred because `serializeWithFrontmatter` spread `...parsed.frontmatter` (parsed from the LLM output or empty fallback) after `prompt: systemPrompt`, overwriting the customized prompt with the default prompt.

---

## Strategic Delegation & Execution

### 1. Backend Engine & Curated Aggregator
- **File**: `app/src/lib/server/courses.ts`
  - Re-implemented `buildAggregatedPayload(courseId: string, type: 'summary' | 'cheatsheet' | 'test')`:
    - **Never passes raw `.lesson.md` files**.
    - **`type === 'test'`**: Gathers curated lesson content prioritizing latest `.summary.md` (or `.summary-N.md`), falling back to `.cheatsheet.md` if not present. If `.test.md` exists, parses and extracts question prompts and covered quiz topics into an `#### Existing Lesson Quiz Coverage` section to give the LLM test coverage context.
    - **`type === 'summary'`**: Collects latest `.summary.md` (fallback to `.cheatsheet.md`).
    - **`type === 'cheatsheet'`**: Collects latest `.cheatsheet.md` (fallback to `.summary.md`).
    - Strips YAML frontmatter using `parseFrontmatter` to only include clean body text.
    - Added `budgetLessonContent` with per-lesson character limits (2,200 chars for test synthesis, 3,000 for summary, 2,500 for cheatsheet) to ensure total payload remains concise and fits comfortably within model context windows.
    - Returns `''` if no curated materials exist across the course.
- **File**: `app/src/lib/server/llm.ts`
  - Enhanced `LLMService.generateResult` and `LLMService.generate` to accept `options?: { timeoutMs?: number }`.
  - Applied `options?.timeoutMs ?? 90_000` to both `AbortController` and `Promise.race` deadline timer with dynamic timeout error reporting.
- **File**: `app/src/lib/server/api.ts`
  - In `subpath === 'course-docs'` POST handler:
    - Updated payload validation error: `"No curated lesson materials (.summary, .cheatsheet, or .test) found to generate a course-level " + type + ". Please generate some lesson summaries or study sheets first."`
    - Passed `{ timeoutMs: 180_000 }` to `LLMService.generateResult` to provide 3 minutes for comprehensive course-level synthesis.
    - **Guaranteed Exact Prompt Tracking**: Fixed frontmatter serialization precedence so `prompt: systemPrompt` is placed *after* `...parsed.frontmatter`:
      ```typescript
      const content = serializeWithFrontmatter(
        {
          ...parsed.frontmatter,
          type: `course_${type}`,
          updatedAt: new Date().toISOString().split('T')[0],
          prompt: systemPrompt
        },
        parsed.body.trim()
      );
      ```
      This guarantees that whatever custom prompt the user provided (e.g. 24 questions) is the definitive prompt saved in `course.test.md` frontmatter and returned to the UI.
- **File**: `app/src/lib/server/queue.ts`
  - Applied the same frontmatter sanitization pattern in the background queue worker so lesson tasks also cleanly preserve `prompt: systemPrompt` and strip LLM-emitted duplicate frontmatter.

### 2. Frontend UI & PromptCard Polish
- **File**: `app/src/lib/components/PromptCard.svelte`
  - In `handleOpenRegenModal()`: When `versions.length === 0` (course-wide scope), bypasses the version selection modal and directly triggers `onRegenerate(false)`.
  - Prevented opening the modal when `isGenerating` is true.
  - Guarded the modal template with `{#if showRegenModal && versions.length > 0}`.
  - Omitted `(v1)` from the prompt label when `versions.length === 0`, labeling it simply as `Prompt Instructions`.
  - Styled the "Apply & Re-generate" button with `disabled:opacity-50 disabled:cursor-not-allowed`, spinner `<Loader2 class="animate-spin" />`, and label `Generating...` while generating.
  - **Prompt Tracking & Diffing**: Added `defaultPrompt` prop to `PromptCard`. `isModified` now correctly checks whether the card's prompt differs from the default template (`defaultPrompt`), enabling the "Prompt modified" pill and "Reset" action reliably.
- **File**: `app/src/lib/components/QuizRunner.svelte`
  - Added an `$effect` on `testMarkdown` to reset `userAnswers = {}` and `submitted = false` upon new content.
- **File**: `app/src/routes/courses/[course_id]/+page.svelte`
  - In `generateCourseDocument(type)`:
    - On success: explicitly updates `tabContents[type]` and `originalContents[type]` with the returned markdown (which contains the customized prompt in YAML frontmatter).
    - Increments `quizRunnerKey` when `type === 'test'`, ensuring `QuizRunner` cleanly remounts with fresh state.
    - Error handling: improved extraction from API responses (`res.json()` message/error/detail or text fallback) so specific server errors are cleanly surfaced to the user.
    - Passed `defaultPrompt={defaultPromptForActiveTab}` to `PromptCard`.

### 3. Verification & Testing
- **TypeScript Typecheck**: Ran `bun run check` / `svelte-check` — 0 errors, 0 warnings.
- **Unit Tests**: Ran `bun test` — 31 passing tests across 5 files, including dedicated tests verifying custom prompt persistence, cheatsheet math parsing, and currency guard isolation.
- **Payload Verification**: Tested `buildAggregatedPayload` on courses (`baf3m`, `gwl3o`, empty course) verifying curated-only extraction and empty payload fallback handling.

---

## KaTeX Math & Formula Rendering Pipeline with Accounting Currency Protection

### Problem
1. When generating course cheatsheets (e.g. for MCR3U), formulas such as `Rational function (\frac{P(x)}{Q(x)}), (Q(x)\neq0)` and `Exponent division (\frac{x^m}{x^n}=x^{m-n})` were displayed as unrendered raw text with parentheses rather than formatted math notation.
2. In CommonMark / Marked, `\(` escapes `(` (turning it into a literal parenthesis and stripping the backslash), corrupting LaTeX commands before rendering.
3. Accounting courses (e.g. BAF3M) frequently use financial expressions like `$1500 and then $2500` or `$30,000 to $45,000`. Naive math delimiters (`$...$`) could mistakenly combine these into invalid math formulas, destroying currency strings.

### Solution & Implementation
1. **Created Pre-Parsing Math Pipeline (`app/src/lib/markdown/mathRenderer.ts`)**:
   - `extractMathFromMarkdown(text)`: Extracts formulas **before** Marked touches them, substituting them with collision-proof `%%%MATH_TOKEN_N%%%` placeholders.
   - Supports 5 distinct math notations:
     - Display equations: `$$...$$`
     - LaTeX display: `\[...\]`
     - LaTeX inline: `\(...\)`
     - Inline dollar math: `$...$` with strict currency guards (`isLikelyInlineMath`)
     - Parenthesized LaTeX expressions: balanced `(...)` scanning that detects formulas with internal parentheses like `(\frac{P(x)}{Q(x)})`.
   - **Strict Accounting Currency Guard (`isLikelyInlineMath`)**:
     - Immediately rejects any string starting with digits or currency punctuation (`$1500`, `$45,000`).
     - Detects English prose keywords (`and`, `then`, `revenue`, `assets`, `inventory`, `per hour`) and words $\ge 3$ characters without LaTeX symbols, guaranteeing currency amounts remain literal text.
   - `restoreMathTokens(html, tokens)`: Renders extracted tokens using `katex.renderToString(..., { throwOnError: false })`.
2. **Integrated into Markdown Viewer (`app/src/lib/components/MarkdownViewer.svelte`)**:
   - Pre-extracts math tokens before `markedParser.parse()`, then restores rendered KaTeX HTML strings afterwards.
   - Post-it notes also run through the same math pipeline.
3. **Integrated into PDF Pipeline (`app/src/lib/pdf/markdown/mathText.ts`)**:
   - `splitMathSegments(input)` now uses `extractMathFromMarkdown`, ensuring PDF exports render `\[...\]`, `\(...\)`, and parenthesized formulas into linear Unicode text while preserving financial currency.
   - Fixed single-character exponent group consumption in `readGroup` (`^2` now correctly translates without duplicate characters).
4. **Updated Prompt Templates (`data/prompts/`)**:
   - Added explicit `## Math & Formula Notation:` guidelines to `course_cheatsheet.md`, `cheatsheet.md`, `course_summary.md`, `summary.md`, `course_test.md`, and `test.md`.
   - Directs the LLM to write inline math with `$formula$`, display equations with `$$formula$$`, never use bare parentheses `(\frac{a}{b})`, and write currency values like `$1,500` normally.
