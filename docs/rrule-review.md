# Verdict
The architectural inversion is the right call, and the plan is unusually well-grounded — the parser-compatibility claims check out, rrule@2.8.1 is already installed in both package.jsons, and the zero-failure fallback is a genuinely valuable property. I verified the skeleton format (- [ ] **Study** 01.01 — Title (60m), /summary sections, 01.05_assign1 ids, em-dash titles, trailing durations, 2-space indented descriptions, ### YYYY-MM-DD · Ddd headers) against ENTRY_RE and matchDayHeader in 
scheduleParser.ts:30-49
 — it all parses correctly. That said, there are three issues that will break the design as written, plus a recommendation that I think materially improves the enrichment stage.

## Critical issues
1. The enrichment acceptance gate is self-defeating. The plan gates acceptance on validation.ok && validation.warnings.length === 0 (§7), but validateScheduleMarkdown flags any lessonId not in the manifest (
scheduleValidation.ts:43-45
) — and by the plan's own design, Catchup entries use lessonId: "catchup", which is not a manifest id. So every skeleton and every enriched output will carry the "References unknown lesson id(s): catchup" warning, and enrichment will be discarded 100% of the time, silently falling back to the skeleton. This also contradicts §8's claim that invariant 3 is "mathematically guaranteed." Fix options:

Best: don't re-run advisory validation on the enriched output at all. Instead diff the parsed events: enriched event count === skeleton event count, same date sequence, same lessonIds/types in order. That's a strict structural-equivalence check — it catches dropped/duplicated/reordered entries, is immune to pre-existing advisory warts, and degrades gracefully.
Minimum: special-case catchup in scheduleValidation.ts and compare enriched warnings against the skeleton's warnings (accept if not worse).
2. Density-aware pacing has no data source. buildScheduleSkeleton(course, prefs) takes only the manifest and prefs, but CourseManifestLesson (
courseIngest.ts:10-21
) carries no word counts or density — those are computed server-side with fs access inside buildSchedulePayload/computeSummaryDensity (
courses.ts:587-594
). The engine lives in shared app/src/lib with no fs. Phase 2's density features are unimplementable as spec'd. Add an explicit LessonEffort[] input (id, wordCount, density, excerpt) that CourseService computes and the queue worker passes in — and note that the enrichment payload builder needs the same excerpts anyway, so one server-side inventory computation should feed both.

3. Behavior on exhausted target capacity is unspecified. §4.2 says "emit an advisory warning," but not what the engine does. Since invariant 1 (lesson coverage) must hold, the only sane answer is: keep scheduling past targetEndDate until inventory is covered, and warn. But the rrule code as written bounds generation with until in target mode, so it can't overflow — the plan needs a second pass (or drop until and slice, checking whether the last date exceeds the target). Specify this before implementation, because it determines the shape of generateStudyCalendarDays.

## Smaller problems
The queue snippet's systemPrompt is undefined in the enrichment try-block — it never shows loading course_schedule_enrichment from PromptService, nor how nextTask.customPrompt (a user's customized schedule prompt) maps to the new flow. Decide: does a custom course_schedule prompt override the enrichment prompt, or is it ignored/migrated? Also decide what the skeleton-only fallback path puts in frontmatter prompt: — legacy schedules persist it for regeneration (queue.ts:375-381); persisting the prefs JSON there instead would be the analogous provenance record.

60s enrichment timeout is tight for reasoning models. The plan's own estimates (1–2k reasoning + ~1.5k output tokens) at a modest 20 tok/s already exceed 60s — which is exactly the failure mode you're escaping. Use 120s, and route it through resolveRequestTimeoutMs like the current 300s floor does (queue.ts:366) so the Settings knob still behaves.

catchup href wart: eventHref will send students to /courses/{id}/catchup, a lesson that doesn't exist. Add catchup to the existing special-cases alongside schedule/course (scheduleParser.ts:307-329), or render catchup entries without a link.

exam SessionType has no manifest source — nothing in the ingest model produces exams. Drop it from v1 or define where it comes from.

buildSchedulePrompt becomes dead code — the STUDENT PREFERENCES block (including the capacity estimate the engine now computes exactly) is no longer consumed by anything. Mark it for removal in Phase 3 rather than leaving two preference-serialization paths.

The current untracked scheduleGenerator.ts is leftover reminder-scheduling code from another project — untyped, and its luxon import isn't even in package.json. The plan correctly says "rewrite"; nothing there is worth salvaging except the timezone-anchor lesson.

Answers to the plan's own review questions (§10)
exdate safety: Yes, given the exact-datetime match — the noon-UTC anchoring of both dtstart and every exdate is precisely what makes it work, and it also sidesteps rrule's DST/local-time pitfalls. But honestly, exdate is the more fragile way to do this: a plain post-filter (occurrences.filter(d => !blackoutSet.has(iso(d)))) is trivially testable and makes the question disappear. Use exdate only if you want the ical/toText() outputs to reflect the exclusions — which this app doesn't use.

Schema fidelity: Verified against the regexes — the skeleton format is fully compatible. The real deviation risk is LLM enrichment corrupting structure, which the gate handles (see issue 1).

Fallback safety: Too strict in the wrong dimension (catchup warning always fails it) and too loose in another — validation.ok is only false when zero events parse, and nothing checks that the enriched output didn't drop or duplicate entries. The event-diff check fixes both.

Capacity: See issue 3 — the algorithm must define overflow behavior, not just warn.

## One design recommendation worth considering
The echo-the-whole-document enrichment contract is the weakest link. The LLM spends over half its output tokens re-typing dates and checkboxes it was instructed not to touch, and a single corrupted line either nukes the whole enrichment (failing the gate) or slips through. The stronger contract: ask the LLM to return only a JSON patch — keyed by lessonId + date (or skeleton line index) → {title, description} — and splice it into the skeleton deterministically. Output drops to a few hundred tokens, calendar corruption becomes impossible by construction rather than detected-and-discarded, partial responses degrade per-entry instead of all-or-nothing, and the timeout concern mostly evaporates. The whole-doc echo is simpler to prompt for, but the JSON-patch version is strictly better on every axis the plan optimizes for. Either way, your §5.3 output-token estimate is optimistic for a 30-lesson course once descriptions are added — another point in favor of the patch format.

### Test suggestions for Phase 2
Beyond the listed items: blackout spanning New Year, targetEndDate falling on a non-study day, startDate not on a study day, single study-day-per-week, capacity < lesson count, and a property-style test asserting every emitted date's weekday ∈ studyDays, no date in any blackout range, and strict chronology. Bun's test runner is already in use (scheduleParser.test.ts etc.), so this fits the existing harness.

Bottom line: approve the direction, but resolve issues 1–3 before Phase 2 starts — issue 1 in particular would ship a "working" system where enrichment never actually applies, which is the exact kind of silent failure this redesign is meant to eliminate.