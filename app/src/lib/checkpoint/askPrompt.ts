/**
 * Ask-AI prompt assembly for checkpoints.
 *
 * The system prompt comes from the editable `checkpoint_ask` template in the
 * Prompts system (data/prompts/checkpoint_ask.md). The user prompt is built
 * here with clearly labeled fields and the COMPLETE lesson reference — no
 * silent truncation; context-limit failures must surface, not shorten.
 */

export interface CheckpointAskContext {
  courseTitle: string;
  lessonTitle: string;
  /** Tab the quotation was taken from (e.g. lesson, summary) */
  sourceTab?: string;
  /** Exact selected passage, when the student selected one */
  quote?: string;
  /** The student's typed question */
  question: string;
  /** Full reference text for the document the quote belongs to */
  referenceText: string;
}

/** Default template seeded into the Prompts system when absent. Never overwrites user edits. */
export const DEFAULT_CHECKPOINT_ASK_PROMPT = `You are an expert Ontario secondary school tutor. A student studying course material has selected a passage and asked a question about it.

Answer the student's question directly, clearly, and insightfully in the context of the Ontario curriculum and the lesson material provided. Emphasize key terms, definitions, or concepts in bold. Keep the answer focused (1 to 3 short paragraphs or bullet points). Do not repeat the student's question or include conversational filler.

The selected passage and the full lesson text are provided as reference material in the user message: treat them as sources to ground your answer, not as questions to answer themselves.`;

export function buildCheckpointAskUserPrompt(ctx: CheckpointAskContext): string {
  const parts: string[] = [];
  parts.push(`Course: ${ctx.courseTitle || 'Unknown course'}`);
  parts.push(`Lesson: ${ctx.lessonTitle || 'Unknown lesson'}`);
  if (ctx.sourceTab) {
    parts.push(`Quotation source tab: ${ctx.sourceTab}`);
  }
  if (ctx.quote && ctx.quote.trim()) {
    parts.push('');
    parts.push('Selected passage (the student selected this text and is asking about it):');
    parts.push('<selected_passage>');
    parts.push(ctx.quote.trim());
    parts.push('</selected_passage>');
  }
  parts.push('');
  parts.push("Student's question:");
  parts.push('<question>');
  parts.push(ctx.question.trim());
  parts.push('</question>');
  parts.push('');
  parts.push(
    ctx.quote && ctx.quote.trim()
      ? 'Full lesson reference (context for the selected passage; use as reference material):'
      : 'Full lesson reference (the student is reading this document; use as reference material):'
  );
  parts.push('<lesson>');
  parts.push(ctx.referenceText);
  parts.push('</lesson>');
  return parts.join('\n');
}
