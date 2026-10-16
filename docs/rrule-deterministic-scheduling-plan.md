# Architecture Plan: RRule Deterministic Scheduling & LLM Enrichment

**Document Version:** 1.1.0 (Post-Review Revision)  
**Date:** 2026-10-15  
**Target:** ILC Study Tool (Tauri v2 + SvelteKit 5 + Bun)  
**Status:** Approved Architecture Plan  

---

## 1. Executive Summary & Problem Statement

### 1.1 The Problem
In the original implementation of the Course Study Tool, generating a course study schedule (`course.schedule.md`) relied entirely on an LLM to perform two disparate tasks in a single generative pass:
1. **Calendar Arithmetic & Constraint Satisfaction**: Calculating calendar dates, aligning study days to specific weekdays, handling month boundaries/leap years, spacing review intervals, pacing across calendar weeks, and packing sessions within deadline caps.
2. **Pedagogical Content Enrichment**: Reading course lesson summaries and formulating active-recall review tasks, lesson focus descriptions, and assignment research/draft/revision phases.

When using high-capability reasoning models (such as `deepseek-flash` or DeepSeek-R1 via OpenAI-compatible endpoints), empirical testing revealed severe failure modes:
- **Massive Internal Reasoning Overhead**: The LLM generates **~25,000 internal reasoning tokens** (77,000+ characters) attempting to solve calendar math and constraint scheduling before outputting any visible tokens.
- **Connection Latency & Timeouts**: Generating a full schedule takes **115–135 seconds**. Even with HTTP streaming (`stream: true`) preventing reverse-proxy idle drops, the wall-clock time is excessive and burns substantial token quotas.
- **Fragility**: LLMs are prone to subtle calendar math hallucinations (e.g., mismatching date and day-of-week, skipping dates, or violating hard calendar blackout rules).
- **All-or-Nothing Risk**: If an LLM call times out or encounters a token budget cap, the entire schedule generation fails, leaving the student with nothing.

### 1.2 The Solution: Inverted Architecture
We decouple calendar generation from pedagogical content enrichment:
- **Deterministic Scheduling Engine (`scheduleGenerator.ts` via `rrule@2.8.1`)**: Generates 100% of the calendar dates, handles blackout/holiday exclusions, paces lesson inventory across available capacity, assigns session types (`Study`, `Review`, `Practice`, `Assignment`, `Submit`, `Catchup`), and formats a fully valid Markdown skeleton in **< 10 milliseconds**.
- **Lightweight LLM Enrichment Layer**: Receives the pre-computed skeleton with exact dates and lesson references, along with concise lesson summary excerpts. Its only job is to provide concrete session titles and active-recall retrieval practice descriptions.
- **JSON Patch Enrichment Contract**: Rather than echoing the entire markdown document (wasting tokens and risking calendar corruption), the LLM outputs a compact JSON patch. The engine merges these patches into the skeleton deterministically.
- **Zero-Failure Fallback Guarantee**: If the LLM enrichment fails, times out, or returns invalid data, the deterministic skeleton is already fully valid, compliant with `ScheduleParser` and `validateScheduleMarkdown`, and immediately usable by the student.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          User Preferences Input                             │
│ (Start Date, Study Days, Pace Mode, Blackout Date Ranges, Catch-up Toggle) │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│             Deterministic Scheduling Engine (scheduleGenerator.ts)          │
│                                                                             │
│  1. Server analyzes lesson effort (word counts, density, excerpts)          │
│  2. RRule: Generate calendar dates; post-filter Blackout Ranges             │
│  3. Inventory Packer: Distribute Lessons, Reviews, Assignments & Catchups   │
│  4. Skeleton Formatter: Produce structured Markdown + Session Index        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │ Valid Markdown Skeleton (0ms delay)        │
                 ▼                                           ▼
┌─────────────────────────────────────────┐     ┌────────────────────────────┐
│      Fast Path / Fallback               │     │    JSON Patch Enrichment   │
│   (Save deterministic skeleton directly │     │  - Input: Sessions +       │
│    with default titles & templates)     │     │           Lesson Excerpts  │
│                                         │     │  - LLM returns {title,     │
│                                         │     │    description} per session│
│                                         │     │  - Runtime: ~4-8s (~400tok)│
└─────────────────────────────────────────┘     └────────────┬───────────────┘
                                                             │
                                                             ▼
                                                ┌────────────────────────────┐
                                                │ Deterministic Merge Engine │
                                                │ (Splice patches into       │
                                                │  skeleton; 1:1 invariants) │
                                                └────────────┬───────────────┘
                                                             │
                                                             ▼
                                                ┌────────────────────────────┐
                                                │ Enriched course.schedule.md│
                                                └────────────────────────────┘
```

---

## 2. Technical Requirements & Design Objectives

1. **Deterministic Calendar Math**:
   - Zero LLM involvement in computing dates, days of the week, week numbers, or date intervals.
   - Use `rrule@2.8.1` (`RRule`, `RRuleSet`) to model recurrence and blackout exclusions.
   - Standardize on ISO-8601 strings (`YYYY-MM-DD`) and UTC date boundaries without external timezone libraries (`luxon` is excluded).

2. **Blackout / Holiday Exclusions**:
   - Users can specify one or more date ranges (e.g. `2026-12-21` to `2027-01-03` for Winter Break) with an optional label (e.g. "Winter Break").
   - The engine strictly excludes any date falling within these ranges using a verified set-based post-filter over the recurrence stream.

3. **Catch-up Days Support & Pseudo-Lesson Handling**:
   - Checkbox preference: `[x] Include catch-up buffer days` (default: `true`).
   - When enabled, the engine inserts a `Catchup` session roughly every 5–7 study sessions (~15% of sessions) to account for the planning fallacy.
   - In `scheduleValidation.ts` and `scheduleParser.ts`, `catchup` is recognized as a valid system pseudo-lesson so it does NOT trigger unknown lesson warnings or broken links.

4. **Pedagogical Constraints Alignment**:
   - **Distributed Practice**: Spaced review sessions scheduled 2–4 study days after lesson completion.
   - **Assignment Backward Planning**: Multi-phase assignment slots (`/research`, `/draft`, `/revise`) terminating in a `Submit` entry, with at least 1 study day buffer before the submission slot.
   - **Density-Aware Pacing**: High-density lessons (conceptually dense) allocated longer or split study slots, powered by a dedicated `LessonEffort` data source.
   - **Review Intensity Toggle**: Honor `includeReviews` (boolean) and `reviewIntensity` (`light` | `standard` | `heavy`).

5. **Uncapped Overflow Behavior for Target Deadlines**:
   - Invariant 1 (every content lesson must be scheduled) is absolute.
   - If a student sets an aggressive `targetEndDate` with fewer slots than required lessons, the engine compresses non-essential slots (catchups, reviews), but **never drops lessons**.
   - If inventory still overflows, the engine continues scheduling past `targetEndDate` and emits an advisory warning banner with the calculated completion date.

6. **Schema & Parser Compatibility**:
   - The output must pass existing `ScheduleParser.parseMarkdown()` tests without schema mutations.
   - Line-level checkbox toggling (`toggleEventDone`) in `ScheduleViewer` remains fully operational.

7. **Performance & Token Reduction**:
   - Reduce LLM input tokens from ~20,000 to < 2,000.
   - Reduce LLM output tokens from ~28,000 (including reasoning) to < 600.
   - Reduce generation wall-clock latency from 120s+ to < 10s.

---

## 3. Data Models & Interface Contracts

### 3.1 Updated `SchedulePreferences` (`app/src/lib/schedule.ts`)

```typescript
export type ReviewIntensity = 'light' | 'standard' | 'heavy';
export type PaceMode = 'steady' | 'target';

export interface BlackoutDateRange {
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  /** Optional user label, e.g. "Winter Break", "March Break", "Exams" */
  label?: string;
}

export interface SchedulePreferences {
  /** YYYY-MM-DD — first possible study day */
  startDate: string;
  /** JS getDay() values, 0=Sun … 6=Sat */
  studyDays: number[];
  sessionLengthMin: number;
  sessionsPerDay: number;
  paceMode: PaceMode;
  /** Required when paceMode === 'target' (YYYY-MM-DD) */
  targetEndDate?: string;
  /** When false, no Review or Practice entries are generated */
  includeReviews: boolean;
  reviewIntensity: ReviewIntensity;
  /** Blackout date ranges where no study sessions will be scheduled */
  blackoutDates: BlackoutDateRange[];
  /** Allocate ~1 catch-up buffer session per week (~15% of total sessions) */
  includeCatchupDays: boolean;
  /** Free-form notes/constraints */
  notes?: string;
}
```

### 3.2 Lesson Effort & Inventory Data Source

Because the client-side engine cannot access the filesystem directly, `CourseService` (`app/src/lib/server/courses.ts`) extracts effort signals during pre-processing:

```typescript
export interface LessonEffort {
  lessonId: string;
  title: string;
  type: 'lesson' | 'assignment';
  wordCount: number;
  summaryDensity: 'low' | 'medium' | 'high';
  excerpt: string; // 100-150 char high-yield snippet from summary
}
```

### 3.3 Intermediate Slot & Session Types (`app/src/lib/scheduleGenerator.ts`)

```typescript
export type SessionType =
  | 'study'
  | 'review'
  | 'practice'
  | 'assignment'
  | 'submit'
  | 'catchup';

export interface PlannedSession {
  /** Deterministic unique session key, e.g. "2026-10-19:01.01:study" */
  sessionKey: string;
  date: string;          // YYYY-MM-DD
  dayLabel: string;      // Mon, Tue...
  weekNumber: number;
  type: SessionType;
  lessonId: string;      // e.g. "01.02", "01.05_assign1", or "catchup"
  section?: string;      // e.g. "summary", "test", "draft", "revise"
  title: string;         // Default title, can be enriched by LLM
  description?: string;  // Concrete retrieval task or focus
  durationMin: number;   // Minutes
}

export interface ScheduleSkeleton {
  title: string;
  summaryLine: string;
  markdown: string;
  sessions: PlannedSession[];
  overflowWarning?: string; // Present if targetEndDate was exceeded
}
```

### 3.4 JSON Patch Enrichment Contract

```typescript
export interface SessionEnrichmentPatch {
  /** Matches PlannedSession.sessionKey OR (lessonId + type) */
  sessionKey: string;
  title: string;
  description: string;
}
```

---

## 4. Deterministic Scheduling Engine Architecture

The file `app/src/lib/scheduleGenerator.ts` is rewritten as a pure TypeScript module using `rrule@2.8.1`. It has zero dependencies on `luxon`.

### 4.1 Calendar Day Generation with Blackout Set-Filtering

Rather than relying solely on `RRuleSet.prototype.exdate()` (which requires exact millisecond datetime equality), the engine uses a **noon-UTC anchored RRule combined with an authoritative Set-based post-filter**. This eliminates any possibility of DST or timezone mismatches:

```typescript
import { RRule } from 'rrule';

const RRULE_WEEKDAY_MAP = [
  RRule.SU, // 0
  RRule.MO, // 1
  RRule.TU, // 2
  RRule.WE, // 3
  RRule.TH, // 4
  RRule.FR, // 5
  RRule.SA  // 6
];

/**
 * Builds an array of available study dates (YYYY-MM-DD) matching user study days
 * and strictly omitting any date in user-defined blackout ranges.
 *
 * NOTE: Does NOT cap with 'until' when in target mode — inventory coverage takes
 * precedence. The allocator checks if dates exceed targetEndDate and warns.
 */
export function generateStudyCalendarDays(
  prefs: SchedulePreferences,
  totalDaysNeeded: number
): string[] {
  const [startYear, startMonth, startDay] = prefs.startDate.split('-').map(Number);
  // Anchor at noon UTC to prevent DST transitions from shifting the calendar date
  const dtstart = new Date(Date.UTC(startYear, startMonth - 1, startDay, 12, 0, 0));

  // Build the Set of blacklisted ISO dates
  const blackoutSet = new Set<string>();
  for (const range of prefs.blackoutDates || []) {
    if (!range.startDate || !range.endDate) continue;
    const [by, bm, bd] = range.startDate.split('-').map(Number);
    const [ey, em, ed] = range.endDate.split('-').map(Number);
    const cur = new Date(Date.UTC(by, bm - 1, bd, 12, 0, 0));
    const end = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));

    while (cur <= end) {
      blackoutSet.add(cur.toISOString().split('T')[0]);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  const byweekday = prefs.studyDays.map((d) => RRULE_WEEKDAY_MAP[d]);
  
  const rule = new RRule({
    freq: RRule.WEEKLY,
    byweekday,
    dtstart
  });

  // Fetch ample occurrences, then post-filter against blackoutSet
  const maxFetch = Math.max(totalDaysNeeded * 4, 365);
  const rawOccurrences = rule.all((_, i) => i < maxFetch);

  const validDates: string[] = [];
  for (const dateObj of rawOccurrences) {
    const iso = dateObj.toISOString().split('T')[0];
    if (!blackoutSet.has(iso)) {
      validDates.push(iso);
      if (validDates.length >= totalDaysNeeded) break;
    }
  }

  return validDates;
}
```

### 4.2 Slot Allocation & Pedagogical Pacing Algorithm

The allocator maps the course inventory into study dates:

```typescript
export function buildScheduleSkeleton(
  course: CourseManifest,
  prefs: SchedulePreferences,
  efforts: LessonEffort[] = []
): ScheduleSkeleton {
  const effortMap = new Map(efforts.map((e) => [e.lessonId, e]));

  // 1. Compile required sessions list
  const plannedSessions: Omit<PlannedSession, 'date' | 'dayLabel' | 'weekNumber' | 'sessionKey'>[] = [];
  
  const allLessons = course.units.flatMap((u) => u.lessons);

  for (const lesson of allLessons) {
    const effort = effortMap.get(lesson.id);
    const isHighDensity = effort?.summaryDensity === 'high' || (effort?.wordCount || 0) > 3000;

    if (lesson.type === 'lesson') {
      if (isHighDensity && prefs.sessionLengthMin >= 60) {
        // Split high-density lessons into two study sessions
        plannedSessions.push({
          type: 'study',
          lessonId: lesson.id,
          title: `${lesson.title} (Part 1)`,
          durationMin: Math.round(prefs.sessionLengthMin * 0.75)
        });
        plannedSessions.push({
          type: 'study',
          lessonId: lesson.id,
          title: `${lesson.title} (Part 2)`,
          durationMin: Math.round(prefs.sessionLengthMin * 0.75)
        });
      } else {
        plannedSessions.push({
          type: 'study',
          lessonId: lesson.id,
          title: lesson.title,
          durationMin: prefs.sessionLengthMin
        });
      }

      // Add spaced review if reviews are enabled
      if (prefs.includeReviews) {
        plannedSessions.push({
          type: 'review',
          lessonId: lesson.id,
          section: 'summary',
          title: `${lesson.title} — Recall Check`,
          durationMin: Math.max(15, Math.round(prefs.sessionLengthMin * 0.3))
        });
      }
    } else if (lesson.type === 'assignment') {
      // Backward planning: research -> draft -> submit
      plannedSessions.push({
        type: 'assignment',
        lessonId: lesson.id,
        section: 'research',
        title: `${lesson.title} — Research & Planning`,
        durationMin: prefs.sessionLengthMin
      });
      plannedSessions.push({
        type: 'assignment',
        lessonId: lesson.id,
        section: 'draft',
        title: `${lesson.title} — Drafting`,
        durationMin: prefs.sessionLengthMin
      });
      plannedSessions.push({
        type: 'submit',
        lessonId: lesson.id,
        title: `${lesson.title} Submission`,
        durationMin: 30
      });
    }

    // Interleave catch-up buffer every ~6 sessions if requested
    if (prefs.includeCatchupDays && plannedSessions.length % 6 === 0) {
      plannedSessions.push({
        type: 'catchup',
        lessonId: 'catchup',
        title: 'Weekly Catch-up Buffer',
        description: 'Review unfinished topics or buffer against unexpected delays.',
        durationMin: prefs.sessionLengthMin
      });
    }
  }

  // 2. Capacity calculation & Target deadline handling
  const sessionsPerDay = Math.max(1, prefs.sessionsPerDay || 1);
  const totalDaysNeeded = Math.ceil(plannedSessions.length / sessionsPerDay);
  const studyDates = generateStudyCalendarDays(prefs, totalDaysNeeded);

  let overflowWarning: string | undefined;
  if (prefs.paceMode === 'target' && prefs.targetEndDate) {
    const lastDate = studyDates[studyDates.length - 1];
    if (lastDate > prefs.targetEndDate) {
      overflowWarning = `Target date ${prefs.targetEndDate} exceeded: ${plannedSessions.length} sessions require scheduling through ${lastDate} at ${sessionsPerDay} session(s)/day.`;
    }
  }

  // 3. Assign calendar slots to sessions
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [startYear, startMonth, startDay] = prefs.startDate.split('-').map(Number);
  const startEpoch = Date.UTC(startYear, startMonth - 1, startDay);

  const finalizedSessions: PlannedSession[] = [];
  let sessionIndex = 0;

  for (let dayIdx = 0; dayIdx < studyDates.length; dayIdx++) {
    const dateStr = studyDates[dayIdx];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayLabel = WEEKDAY_NAMES[dateObj.getUTCDay()];
    const daysSinceStart = Math.floor((dateObj.getTime() - startEpoch) / (86400 * 1000));
    const weekNumber = Math.max(1, Math.floor(daysSinceStart / 7) + 1);

    for (let slot = 0; slot < sessionsPerDay && sessionIndex < plannedSessions.length; slot++) {
      const base = plannedSessions[sessionIndex++];
      const sessionKey = `${dateStr}:${base.lessonId}:${base.type}`;
      finalizedSessions.push({
        ...base,
        sessionKey,
        date: dateStr,
        dayLabel,
        weekNumber
      });
    }
  }

  // 4. Assemble Markdown string
  const markdown = formatScheduleMarkdown(course.id, finalizedSessions, prefs, overflowWarning);

  return {
    title: `${course.id.toUpperCase()} Study Schedule`,
    summaryLine: `*${studyDates[0]} → ${studyDates[studyDates.length - 1]} · ~${prefs.sessionLengthMin}m sessions*`,
    markdown,
    sessions: finalizedSessions,
    overflowWarning
  };
}
```

---

## 5. LLM Enrichment: JSON Patch Architecture

### 5.1 Why JSON Patch Beats Whole-Document Echo
Echoing the entire Markdown file forces the LLM to output 2,500+ tokens re-typing dates, checkboxes, and headers it was instructed not to modify. A single dropped header invalidates the whole file.

With the **JSON Patch Contract**:
- The prompt provides a structured list of sessions requiring enrichment: `[{ sessionKey, lessonId, type, currentTitle }]`.
- The LLM returns a lightweight JSON array containing only `{ sessionKey, title, description }`.
- Output drops from **2,500 tokens to ~400 tokens**.
- Wall-clock time drops from **15s to ~4–7 seconds**.
- Calendar structure, dates, and checkboxes are **100% immune to LLM corruption** by construction.
- Partial completions degrade gracefully: any unpatched session retains its default deterministic title.

### 5.2 System Prompt (`data/prompts/course_schedule.md`)

```markdown
# Course Schedule Enrichment

You are an Ontario academic learning coach. You will be provided with:
1. A list of scheduled study sessions with sessionKey, lessonId, and type.
2. High-yield topic excerpts for each lesson.

Return a JSON array of enrichment patches. For each session:
- "title": A concise, engaging title referencing the lesson's main concept.
- "description": Exactly ONE active-recall task (e.g. "Cover /summary and write down the 3 criteria from memory", "Solve practice problem 2 closed-book"). Never suggest passive re-reading.

Output ONLY valid JSON matching this schema:
[
  {
    "sessionKey": "string",
    "title": "string",
    "description": "string"
  }
]
```

### 5.3 Deterministic Patch Merging

The engine merges the patches into the skeleton:
```typescript
export function applyEnrichmentPatches(
  skeleton: ScheduleSkeleton,
  patches: SessionEnrichmentPatch[]
): string {
  const patchMap = new Map(patches.map((p) => [p.sessionKey, p]));

  const enrichedSessions = skeleton.sessions.map((session) => {
    const patch = patchMap.get(session.sessionKey);
    if (!patch) return session;
    return {
      ...session,
      title: patch.title?.trim() || session.title,
      description: patch.description?.trim() || session.description
    };
  });

  return formatScheduleMarkdown(
    skeleton.title,
    enrichedSessions,
    undefined,
    skeleton.overflowWarning
  );
}
```

---

## 6. Structural Equivalence Acceptance Gate

To ensure robustness, we discard the brittle `validation.warnings.length === 0` check. Instead, we use a **Structural Equivalence Gate**:

```typescript
export function verifyStructuralEquivalence(
  originalSkeleton: ScheduleSkeleton,
  enrichedMarkdown: string
): boolean {
  let enrichedParsed;
  try {
    enrichedParsed = ScheduleParser.parseMarkdown(enrichedMarkdown);
  } catch {
    return false;
  }

  // Event count must match exactly
  if (enrichedParsed.events.length !== originalSkeleton.sessions.length) {
    return false;
  }

  // Date, type, and lessonId must match 1:1 in sequence
  for (let i = 0; i < enrichedParsed.events.length; i++) {
    const enriched = enrichedParsed.events[i];
    const original = originalSkeleton.sessions[i];

    if (
      enriched.date !== original.date ||
      enriched.type.toLowerCase() !== original.type.toLowerCase() ||
      enriched.lessonId !== original.lessonId
    ) {
      return false;
    }
  }

  return true;
}
```

---

## 7. Queue Worker & Resilience Workflow (`queue.ts`)

The background task worker in `app/src/lib/server/queue.ts` executes the robust pipeline:

```typescript
// 1. Gather Course Inventory & Precompute Effort Signals
const course = CourseService.getCourse(nextTask.courseId);
const efforts = CourseService.computeCourseEfforts(nextTask.courseId);

// 2. Parse User Preferences from task / stored prefs
const prefs: SchedulePreferences = nextTask.preferences || defaultSchedulePreferences();

// 3. Generate Deterministic Skeleton (0ms delay)
const skeleton = ScheduleGenerator.buildScheduleSkeleton(course, prefs, efforts);

let finalMarkdown = skeleton.markdown;

// 4. Attempt LLM JSON Patch Enrichment
try {
  this.addLog('info', `[Schedule] Calendar generated. Requesting LLM enrichment...`);

  const enrichmentPayload = CourseService.buildEnrichmentPayload(skeleton.sessions, efforts);

  // Load system prompt template (or custom prompt if provided)
  let systemPrompt = nextTask.customPrompt;
  if (!systemPrompt) {
    systemPrompt = PromptService.getPrompt('course_schedule');
  }

  // 120s floor allows comfortable reasoning without timing out
  const timeoutMs = LLMService.resolveRequestTimeoutMs(effectiveConfig, 120_000, { isFloor: true });

  const result = await LLMService.generateResult(
    effectiveConfig,
    systemPrompt,
    enrichmentPayload,
    {
      timeoutMs,
      onLog: (level, msg) => this.addLog(level, msg)
    }
  );

  // Parse JSON patches from completion
  const patches = JSON.parse(extractJsonFromCompletion(result.completion)) as SessionEnrichmentPatch[];
  if (Array.isArray(patches) && patches.length > 0) {
    const candidateMarkdown = ScheduleGenerator.applyEnrichmentPatches(skeleton, patches);
    
    // Gate with structural equivalence
    if (ScheduleGenerator.verifyStructuralEquivalence(skeleton, candidateMarkdown)) {
      finalMarkdown = candidateMarkdown;
      this.addLog('info', `[Schedule] LLM enrichment applied (${patches.length} patches).`);
    } else {
      this.addLog('warn', `[Schedule] Enrichment failed structural gate. Retaining skeleton.`);
    }
  }
} catch (err) {
  this.addLog('warn', `[Schedule] Enrichment failed (${(err as Error).message}). Using skeleton.`);
}

// 5. Serialize Frontmatter with Provenance Preferences
const finalWithFrontmatter = serializeWithFrontmatter(
  {
    type: 'course_schedule',
    updatedAt: new Date().toISOString().split('T')[0],
    preferences: prefs
  },
  finalMarkdown
);

CourseService.saveCourseDocument(nextTask.courseId, 'schedule', finalWithFrontmatter);
```

---

## 8. UI / UX Design & Navigation Updates

### 8.1 Blackout Dates Section in `SchedulePreferencesModal.svelte`
- Start and End date pickers with optional label.
- Immediate client-side validation (`endDate >= startDate`).
- Added dates shown as removable chip pills:
  `[ 🏝️ 2026-12-21 – 2027-01-03 (Winter Break) ✕ ]`

### 8.2 Catch-up Days Toggle
- Checkbox: `[x] Include catch-up buffer days (~1 per week)` (default: `true`).

### 8.3 Navigation & Parser Fixes
- **`catchup` Link Fix**: In `app/src/lib/parser/scheduleParser.ts`, update `eventHref()`:
  ```typescript
  if (event.lessonId === 'catchup' || event.type === 'catchup') {
    return null; // Unclickable chip, does not link to 404 /courses/{id}/catchup
  }
  ```
- **Validation Fix**: In `app/src/lib/parser/scheduleValidation.ts`:
  ```typescript
  // Exclude pseudo-system lessons from unknown lesson check
  const SYSTEM_LESSONS = new Set(['catchup']);
  const unknown = [...new Set(events.map((e) => e.lessonId).filter((id) => !known.has(id) && !SYSTEM_LESSONS.has(id)))];
  ```

---

## 9. Testing & Property-Based Verification Plan

A dedicated test suite `app/src/lib/scheduleGenerator.test.ts` will verify:
1. **RRule Date Correctness**:
   - Every generated date's weekday $\in$ `prefs.studyDays`.
   - Dates are strictly monotonically increasing.
2. **Blackout Invariants**:
   - Multi-day blackout ranges: zero emitted dates fall within `[startDate, endDate]`.
   - New Year boundary blackout (e.g., Dec 23 to Jan 4) spans months/years seamlessly.
3. **Boundary Edge Cases**:
   - `startDate` not falling on a study day (engine advances to first valid study day).
   - `targetEndDate` falling on a non-study day (engine finishes on or before target if capacity permits).
   - Single study-day per week (e.g. Sundays only).
4. **Capacity & Overflow**:
   - When required sessions > available target slots, invariant 1 holds (all lessons scheduled) and `overflowWarning` is emitted.
5. **Structural Equivalence & Patching**:
   - Applying empty patches returns original skeleton.
   - Applying valid patches updates `title` and `description` while preserving 100% of dates, week headers, and checkboxes.
6. **Parser & Validation Compliance**:
   - `ScheduleParser.parseMarkdown()` parses every event without data loss.
   - `validateScheduleMarkdown()` passes with zero warnings on standard courses.

---

## 10. Execution Order & Phase Breakdown

1. **Phase 1: Foundations & Models**
   - Update `SchedulePreferences` in `app/src/lib/schedule.ts`.
   - Update `SchedulePreferencesModal.svelte` with blackout date range inputs and catch-up checkbox.
   - Fix `scheduleParser.ts` (`eventHref`) and `scheduleValidation.ts` to recognize `catchup`.

2. **Phase 2: Deterministic Engine & Tests**
   - Rewrite `app/src/lib/scheduleGenerator.ts` using `rrule@2.8.1`.
   - Implement `generateStudyCalendarDays` with noon-UTC anchor and Set post-filtering.
   - Implement `buildScheduleSkeleton`, `applyEnrichmentPatches`, and `verifyStructuralEquivalence`.
   - Add unit tests in `app/src/lib/scheduleGenerator.test.ts`.

3. **Phase 3: Server Inventory & Enrichment**
   - Implement `CourseService.computeCourseEfforts` in `app/src/lib/server/courses.ts`.
   - Update `data/prompts/course_schedule.md`.
   - Deprecate legacy `buildSchedulePrompt` in `schedule.ts`.

4. **Phase 4: Queue Integration & Verification**
   - Update `app/src/lib/server/queue.ts` schedule worker.
   - Run end-to-end tests with `bun test`.
   - Verify on live course generation in the app.
