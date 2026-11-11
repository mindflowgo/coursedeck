import { describe, expect, it } from 'bun:test';
import { buildCheckpointAskUserPrompt, DEFAULT_CHECKPOINT_ASK_PROMPT } from './askPrompt';

describe('buildCheckpointAskUserPrompt', () => {
  const filler = 'Instructional paragraph explaining a concept in careful detail. ';
  const longLesson = filler.repeat(200); // ~13,000 chars — far beyond the old 4,000 slice
  const sentinel = 'SENTINEL_NEAR_END_7f3a';

  it('keeps the complete lesson reference — no 4,000 character truncation', () => {
    const lesson = longLesson.slice(0, 9000) + ' ' + sentinel + ' ' + longLesson.slice(9001);
    const prompt = buildCheckpointAskUserPrompt({
      courseTitle: 'MHF4U',
      lessonTitle: 'Lesson 1 — Polynomial Functions',
      sourceTab: 'summary',
      quote: 'the leading coefficient',
      question: 'Why does the sign of a matter for end behaviour?',
      referenceText: lesson
    });

    // The sentinel sits near the end of a >4,000 char lesson and must survive.
    expect(prompt).toContain(sentinel);
    expect(prompt.length).toBeGreaterThan(lesson.length);

    // Quote and question travel as separate labeled fields.
    const quoteIdx = prompt.indexOf('<selected_passage>');
    const questionIdx = prompt.indexOf('<question>');
    const lessonIdx = prompt.indexOf('<lesson>');
    expect(quoteIdx).toBeGreaterThan(-1);
    expect(prompt).toContain('the leading coefficient');
    expect(prompt).toContain('Why does the sign of a matter for end behaviour?');
    expect(prompt.indexOf('Quotation source tab: summary')).toBeGreaterThan(-1);
    // Order: quote block before question block before lesson block.
    expect(quoteIdx).toBeLessThan(questionIdx);
    expect(questionIdx).toBeLessThan(lessonIdx);
  });

  it('omits the passage block when no selection was made', () => {
    const prompt = buildCheckpointAskUserPrompt({
      courseTitle: 'BAF3M',
      lessonTitle: 'Accounting Fundamentals',
      question: 'Summarize this section',
      referenceText: 'Short lesson body'
    });
    expect(prompt).not.toContain('<selected_passage>');
    expect(prompt).toContain("Student's question:");
    expect(prompt).toContain('<lesson>');
  });

  it('provides a default system prompt template', () => {
    expect(DEFAULT_CHECKPOINT_ASK_PROMPT.length).toBeGreaterThan(100);
    expect(DEFAULT_CHECKPOINT_ASK_PROMPT.toLowerCase()).toContain('tutor');
  });
});
