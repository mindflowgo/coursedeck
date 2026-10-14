import { describe, it, expect } from 'bun:test';
import {
  ScheduleParser,
  toggleEventDone,
  eventHref,
  type ScheduleEvent
} from './scheduleParser';

const SAMPLE = `---
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
  Gather sources; note key citations.
  Draft the outline structure.
- [ ] **Submit** 01.05_assign1 — Assignment 1 due
`;

describe('ScheduleParser.parseMarkdown', () => {
  const parsed = ScheduleParser.parseMarkdown(SAMPLE);

  it('parses the title and summary line, ignoring frontmatter', () => {
    expect(parsed.title).toBe('MCR3U Study Schedule');
    expect(parsed.summaryLine).toBe('Oct 13 → Dec 18 · Mon/Wed/Thu · ~60m sessions');
  });

  it('parses dates and day labels from ### headers', () => {
    const study = parsed.events.find((e) => e.title === 'Course intro and prerequisites');
    expect(study?.date).toBe('2026-10-13');
    expect(study?.dayLabel).toBe('Tue');
  });

  it('parses a full entry: type, lessonId, title, duration', () => {
    const submit = parsed.events.find((e) => e.type === 'submit');
    expect(submit).toBeDefined();
    expect(submit!.lessonId).toBe('01.05_assign1');
    expect(submit!.section).toBeUndefined();
    expect(submit!.title).toBe('Assignment 1 due');
    expect(submit!.durationMin).toBeUndefined();
  });

  it('parses the /section suffix (known tabs and free-form)', () => {
    const review = parsed.events.find((e) => e.type === 'review');
    expect(review?.lessonId).toBe('01.01');
    expect(review?.section).toBe('summary');

    const research = parsed.events.find((e) => e.section === 'research');
    expect(research?.lessonId).toBe('01.05_assign1');
    expect(research?.durationMin).toBe(45);
  });

  it('joins single and multi-line indented descriptions', () => {
    const study = parsed.events.find((e) => e.title === 'Course intro and prerequisites');
    expect(study?.description).toBe('Prereq review of linear functions.');

    const research = parsed.events.find((e) => e.section === 'research');
    expect(research?.description).toBe(
      'Gather sources; note key citations. Draft the outline structure.'
    );
  });

  it('reads done state from the checkbox', () => {
    const review = parsed.events.find((e) => e.type === 'review');
    expect(review?.done).toBe(true);
    expect(parsed.events.filter((e) => !e.done).length).toBe(3);
  });

  it('records the raw lineIndex of each checkbox line', () => {
    const lines = SAMPLE.split('\n');
    for (const e of parsed.events) {
      expect(lines[e.lineIndex]).toMatch(/^-\s?\[[ xX]\]/);
    }
  });
});

describe('ScheduleParser tolerance', () => {
  it('ignores stray prose and blank lines', () => {
    const parsed = ScheduleParser.parseMarkdown(
      '# Plan\n\nSome intro prose.\n\n### 2026-10-13 · Mon\n- [ ] **Study** 01.01 — Intro (30m)\n\nA closing note.\n'
    );
    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0].title).toBe('Intro');
  });

  it('tolerates entries before any date header', () => {
    const parsed = ScheduleParser.parseMarkdown('# Plan\n\n- [ ] **Study** 01.01 — Early (30m)\n');
    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0].date).toBe('');
  });

  it('never throws on garbage input', () => {
    expect(() => ScheduleParser.parseMarkdown('')).not.toThrow();
    expect(() => ScheduleParser.parseMarkdown('### \n- [ ] broken\n- [ ] **Study** nope\n')).not.toThrow();
    expect(ScheduleParser.parseMarkdown('').events.length).toBe(0);
  });

  it('parses week headers without losing events', () => {
    const parsed = ScheduleParser.parseMarkdown(
      '# P\n\n## Week 1\n\n### 2026-10-13 · Mon\n- [ ] **Study** 01.01 — A (30m)\n\n## Week 2\n\n### 2026-10-20 · Mon\n- [ ] **Study** 01.02 — B (30m)\n'
    );
    expect(parsed.events.map((e) => e.title)).toEqual(['A', 'B']);
    expect(parsed.events[1].date).toBe('2026-10-20');
  });

  it('tolerates hyphen, colon, and en-dash separators in entry lines', () => {
    const parsed = ScheduleParser.parseMarkdown(`
### 2026-10-14 - Wednesday
- [ ] **Study** 01.01 - Introduction with ASCII hyphen (60m)
- [ ] **Review** 01.01: Review with colon (30 min)
- [ ] **Study** 1.02 – En-dash and single digit lesson (1.5h)
- [ ] **Catchup** — Buffer session without lesson id (45m)
* [x] **Submit** 01.06_assign1: Asterisk bullet (1h)
`);
    expect(parsed.events.length).toBe(5);
    expect(parsed.events[0].date).toBe('2026-10-14');
    expect(parsed.events[0].dayLabel).toBe('Wed');
    expect(parsed.events[0].lessonId).toBe('01.01');
    expect(parsed.events[0].durationMin).toBe(60);

    expect(parsed.events[1].type).toBe('review');
    expect(parsed.events[1].durationMin).toBe(30);

    expect(parsed.events[2].lessonId).toBe('01.02');
    expect(parsed.events[2].durationMin).toBe(90);

    expect(parsed.events[3].type).toBe('catchup');
    expect(parsed.events[3].durationMin).toBe(45);

    expect(parsed.events[4].type).toBe('submit');
    expect(parsed.events[4].done).toBe(true);
    expect(parsed.events[4].durationMin).toBe(60);
  });

  it('parses markdown table fallback when model emits a table instead of checkboxes', () => {
    const tableMd = `
# BAF3M Study Schedule

*Oct 14 → Dec 18 · Mon/Wed/Fri*

| Session | Date | Day | Focus | Notes |
|---:|---|---|---|---|
| 1 | Oct 14 | Wed | Orientation + **1.01 Introduction to Accounting** | Set up binder |
| 2 | Oct 16 | Fri | **1.02 Business Types** | Short lesson |
| 3 | Oct 19 | Mon | **1.06 Unit 1 Summative** | Project |
`;
    const parsed = ScheduleParser.parseMarkdown(tableMd);
    expect(parsed.events.length).toBe(3);
    expect(parsed.events[0].lessonId).toBe('01.01');
    expect(parsed.events[0].dayLabel).toBe('Wed');
    expect(parsed.events[0].title).toBe('1.01 Introduction to Accounting');
    expect(parsed.events[0].description).toBe('Set up binder');
    expect(parsed.events[2].type).toBe('assignment');
  });
});

describe('toggleEventDone', () => {
  it('flips a checkbox line and preserves every other byte', () => {
    const parsed = ScheduleParser.parseMarkdown(SAMPLE);
    const target = parsed.events.find((e) => !e.done)!;

    const after = toggleEventDone(SAMPLE, target.lineIndex);
    const before = SAMPLE.split('\n');
    const lines = after.split('\n');

    expect(lines.length).toBe(before.length);
    expect(lines[target.lineIndex]).toBe(before[target.lineIndex].replace('[ ]', '[x]'));
    const diffs = lines.filter((l, i) => l !== before[i]);
    expect(diffs.length).toBe(1);

    // Toggling back restores the original exactly.
    expect(toggleEventDone(after, target.lineIndex)).toBe(SAMPLE);
  });

  it('also flips done → not done', () => {
    const parsed = ScheduleParser.parseMarkdown(SAMPLE);
    const done = parsed.events.find((e) => e.done)!;
    const after = toggleEventDone(SAMPLE, done.lineIndex);
    expect(after.split('\n')[done.lineIndex]).toContain('[ ]');
  });

  it('leaves the markdown untouched for an invalid line index', () => {
    expect(toggleEventDone(SAMPLE, 3)).toBe(SAMPLE);
    expect(toggleEventDone(SAMPLE, -1)).toBe(SAMPLE);
  });
});

describe('eventHref', () => {
  const base: ScheduleEvent = {
    done: false,
    date: '2026-10-13',
    type: 'study',
    lessonId: '01.05_assign1',
    title: 't',
    lineIndex: 0
  };

  it('links known tabs with &tab=', () => {
    expect(eventHref('mcr3u', { ...base, section: 'summary' })).toBe(
      '/courses/mcr3u?lesson=01.05_assign1&tab=summary'
    );
  });

  it('links free-form sections and bare refs to the lesson', () => {
    expect(eventHref('mcr3u', { ...base, section: 'research' })).toBe(
      '/courses/mcr3u?lesson=01.05_assign1'
    );
    expect(eventHref('mcr3u', base)).toBe('/courses/mcr3u?lesson=01.05_assign1');
  });

  it('lowercases the course id for URL safety', () => {
    expect(eventHref('MCR3U', base)).toBe('/courses/mcr3u?lesson=01.05_assign1');
  });
});
