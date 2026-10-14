# Course Schedule — Design

Date: 2026-10-13
Status: approved (plan rev 2)

## Goal

Add a course-scoped **Schedule** tab that generates `course.schedule.md` from the
course content plus a short scheduling questionnaire, reviewable and tweakable
in-app, plus a `/schedules` dashboard listing courses and their upcoming
sessions. Scheduling-app export is explicitly later — the app's job is to
produce *useful, content-aware* plans that can be tweaked and handed off to
real scheduling apps, not to be one.

## File format (prompt-enforced, parser-tolerant)

One file per course: `data/courses/<id>/course.schedule.md`.

```markdown
---
type: course_schedule
updatedAt: 2026-10-13
---

# MCR3U Study Schedule

*Oct 13 → Dec 18 · Mon/Wed/Thu · ~60m sessions*

## Week 1

### 2026-10-13 · Tue
- [ ] **Study** 01.01 — Course intro and prerequisites (60m)
  Prereq review of linear functions.
- [x] **Review** 01.01/summary — Recall check (20m)

### 2026-10-15 · Thu
- [ ] **Study** 01.05_assign1/research — Research and outline (45m)
- [ ] **Submit** 01.05_assign1 — Assignment 1 due
```

Entry anatomy: `**Type**` (bold activity: study / review / practice /
assignment / submit / exam / catchup) · lessonRef (`NN.NN`, optionally
`_assignN`, optionally `/section`) · ` — title` · `(Nm)` expected time ·
optional indented description line(s).

The `/section` suffix mirrors the `NN.NN.<section>.md` file convention and
makes the entry a hyperlinkable sub-thing:
- section ∈ {summary, cheatsheet, test} → `/courses/{id}?lesson={ref}&tab={section}`
- section absent or free-form (study, research, draft…) → `/courses/{id}?lesson={ref}`,
  section rendered as a label chip

## Data model (`app/src/lib/parser/scheduleParser.ts`)

Mirrors the QuizRunner / questionParser pattern (parse + helpers, no storage
opinions):

```ts
interface ScheduleEvent {
  done: boolean;        // from [ ] / [x]
  date: string;         // YYYY-MM-DD from the ### header ('' if none yet)
  dayLabel?: string;    // Tue
  type: string;         // lowercase activity token, free-form tolerated
  lessonId: string;     // 01.05_assign1
  section?: string;     // summary | study | research | …
  title: string;
  description?: string; // joined indented lines under the entry
  durationMin?: number; // from (60m)
  lineIndex: number;    // line of the checkbox in the raw markdown
}
interface ParsedSchedule { title: string; summaryLine?: string; events: ScheduleEvent[]; }
```

- `toggleEventDone(markdown, lineIndex)` flips only that checkbox line; every
  other byte of the file is preserved (hand edits survive).
- `eventHref(courseId, event)` centralizes link resolution.
- Parser skips stray prose, never throws, tolerates entries before any date
  header.

This parsed shape is the future export payload (ICS / scheduling apps).

## Generation flow

1. Schedule tab, no file yet → intro panel (never auto-calls the LLM).
2. "Build schedule" → `SchedulePreferencesModal`: start date, study days
   (chips), session length (30/45/60/90/120), sessions/day (1–3), pace
   (target end date or steady), review intensity, notes/away days.
3. Modal composes `STUDENT PREFERENCES` block onto the
   `course_schedule` prompt template and calls the existing
   `POST /api/courses/:id/course-docs` with `type: 'schedule'`.
4. Server builds the user payload via `CourseService.buildSchedulePayload`:
   full unit/lesson inventory (id, title, `type: lesson|assignment`) plus
   budgeted (~800 chars/lesson, ~25k total) excerpts from latest curated
   summaries — the content-aware advantage.
5. Result saved as `course.schedule.md`; prompt (incl. preferences) persists
   in its frontmatter like every other doc. PromptCard re-generate reuses it;
   "Rebuild with new preferences" reopens the modal.

## Surfaces

- **Course page**: Schedule tab button (course scope only). Renders
  `ScheduleViewer` (week/day grouping, type badges, durations, linkable
  lessonRef chips, checkbox toggling via the existing PUT save flow,
  progress summary). CodeMirror edit + ⌘S unchanged.
- **`/schedules` dashboard**: fetches `GET /api/schedules`
  (`{ schedules: [{courseId, courseTitle, exists, markdown}] }`), parses
  client-side. Two persisted views: *This week* (chronological today + 7
  days across courses, course-tagged rows, checkboxes) and *By course*
  (progress bar, next unfinished sessions, "Build one" CTA for unscheduled
  courses).
- **Header**: "Schedules" nav link; home course cards get a fifth
  quick-button.

## Out of scope (later)

ICS/scheduling-app export, notifications, drag-reschedule, multiple schedule
versions per course.

## Addendum (2026-10-13, generation v2)

The generation brain was upgraded after a research pass:

- **Prompt v2** encodes evidence-based principles, each with its rationale:
  distributed practice with equal spacing (Cepeda et al. 2006 — spacing is
  robust, optimal gap scales with retention, expanding ≈ equal), retrieval
  practice (reviews must be active recall — Carpenter's spacing guide),
  interleaving in unit reviews (Rohrer et al. 2014 — mixed practice 72% vs
  blocked 38%, "desirable difficulty" caveat), assignment backward planning,
  a ~15% catch-up buffer (planning fallacy), density-aware pacing, and a
  silent self-check before emitting (structured-output research: explicit
  schema + self-verification improves compliance; over-constraining early
  degrades planning).
- **Payload v2** adds a Course Statistics header (counts, total words, rough
  pace guide) and per-lesson effort signals: content word count plus the
  information density of the latest curated summary via
  `computeSummaryDensity` (formula tokens, list items, key terms, headings →
  concepts per 100 words → low/medium/high). Dense lessons get spread over
  more/longer sessions.
- **Questionnaire** gained "Schedule review time?" (`includeReviews`); when
  off, the preferences block forbids Review/Practice entries and the prompt
  treats that as authoritative.
- **Post-generation validation** (`scheduleValidation.ts`): advisory warnings
  for unknown lesson ids, unscheduled content lessons, assignments without
  Submit, invalid/out-of-order dates — returned by the API and shown as a
  dismissible banner that also re-checks hand edits.
