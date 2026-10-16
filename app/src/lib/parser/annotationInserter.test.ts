import { describe, it, expect } from 'bun:test';
import {
  formatUserNote,
  insertAnnotationAfterText,
  removeAnnotation
} from './annotationInserter';

/** Note as it appears on disk: query line, target comment, blockquoted answer. */
function noteMarkdown(query: string, target: string, answer: string): string {
  return formatUserNote(query, target, answer);
}

describe('removeAnnotation', () => {
  const doc = `# Lesson 1.2

The Act states that "statutory discretion" applies broadly.

A plain paragraph without quoted text.
`;

  it('removes a note whose target contains quotes', () => {
    const target = 'The Act states that "statutory discretion" applies broadly.';
    const { updatedMarkdown: withNote } = insertAnnotationAfterText(
      doc,
      target,
      noteMarkdown('Why does this matter?', target, 'Because **good faith** is required.')
    );

    const { updatedMarkdown, removed } = removeAnnotation(withNote, target);

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('USERNOTE');
    expect(updatedMarkdown).toContain('The Act states that "statutory discretion" applies broadly.');
    expect(updatedMarkdown).toContain('A plain paragraph without quoted text.');
  });

  it('removes by query when the note carries no target', () => {
    const withNote = `${doc}\n> [!USERNOTE] Summarize this\n> The answer body.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withNote, 'Summarize this');

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('USERNOTE');
    expect(updatedMarkdown).not.toContain('The answer body');
  });

  it('removes a note sitting at the end of the document', () => {
    const target = 'A plain paragraph without quoted text.';
    const { updatedMarkdown: withNote } = insertAnnotationAfterText(
      doc,
      target,
      noteMarkdown('And this?', target, 'Trailing answer.')
    );

    const { updatedMarkdown, removed } = removeAnnotation(withNote, target);

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('USERNOTE');
    expect(updatedMarkdown.trimEnd().endsWith('A plain paragraph without quoted text.')).toBe(true);
  });

  it('removes only the matching note when several are present', () => {
    const first = insertAnnotationAfterText(
      doc,
      'The Act states that "statutory discretion" applies broadly.',
      noteMarkdown('First question?', 'The Act states that "statutory discretion" applies broadly.', 'First answer.')
    ).updatedMarkdown;
    const both = insertAnnotationAfterText(
      first,
      'A plain paragraph without quoted text.',
      noteMarkdown('Second question?', 'A plain paragraph without quoted text.', 'Second answer.')
    ).updatedMarkdown;

    const { updatedMarkdown, removed } = removeAnnotation(both, 'A plain paragraph without quoted text.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).toContain('First question?');
    expect(updatedMarkdown).toContain('First answer.');
    expect(updatedMarkdown).not.toContain('Second question?');
  });

  it('leaves the document byte-identical when nothing matches', () => {
    const untouched = `${doc}\n\n\n\n> [!NOTE] Callout\n> Keep me.\n`;
    const { updatedMarkdown, removed } = removeAnnotation(untouched, 'no such note');

    expect(removed).toBe(false);
    expect(updatedMarkdown).toBe(untouched);
  });

  it('does not touch blank lines elsewhere in the document', () => {
    // Built by hand: insertion itself normalizes surrounding whitespace, so
    // only a hand-written document proves the removal leaves it alone.
    const target = 'Paragraph with "quotes".';
    const spaced = `# Lesson\n\n${target}\n\n\n\n${noteMarkdown('Q?', target, 'A.')}\n\n# Later section\n\nBody.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(spaced, target);

    expect(removed).toBe(true);
    expect(updatedMarkdown).toBe(`# Lesson\n\n${target}\n\n\n\n# Later section\n\nBody.\n`);
  });

  it('preserves CRLF line endings outside the removed note', () => {
    const crlf = ['# Lesson', '', 'Paragraph one.', '', '> [!USERNOTE] Q?', '> <!-- target: "Paragraph one." -->', '> A.', ''].join('\r\n');
    const { updatedMarkdown, removed } = removeAnnotation(crlf, 'Paragraph one.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).toBe(['# Lesson', '', 'Paragraph one.', ''].join('\r\n'));
  });

  it('removes the note matching both the passage and the question', () => {
    const passage = 'A plain paragraph without quoted text.';
    const first = insertAnnotationAfterText(
      doc,
      passage,
      noteMarkdown('First question?', passage, 'First answer.')
    ).updatedMarkdown;
    const both = insertAnnotationAfterText(
      first,
      passage,
      noteMarkdown('Second question?', passage, 'Second answer.')
    ).updatedMarkdown;

    const { updatedMarkdown, removed } = removeAnnotation(both, passage, 'Second question?');

    expect(removed).toBe(true);
    expect(updatedMarkdown).toContain('First question?');
    expect(updatedMarkdown).not.toContain('Second question?');
    expect(updatedMarkdown).toContain('First answer.');
  });

  it('removes an entire note whose answer contains a callout line', () => {
    // The reader's callout pass can splat a marker-only line out as its own
    // card, but it is text inside the stored answer: deleting the note takes it
    // rather than leaving a stray fragment behind.
    const note = [
      '> [!USERNOTE] Compare the two',
      '> <!-- target: "Paragraph one." -->',
      '> Here is a callout:',
      '> [!NOTE]',
      '> Keep this in mind.',
      '> End of answer.'
    ].join('\n');
    const withNote = `# Lesson\n\nParagraph one.\n\n${note}\n\nTail.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withNote, 'Paragraph one.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('USERNOTE');
    expect(updatedMarkdown).not.toContain('End of answer.');
    expect(updatedMarkdown).toBe('# Lesson\n\nParagraph one.\n\nTail.\n');
  });

  it('prefers an exactly matching note over a longer partial one', () => {
    const exact = `> [!USERNOTE] Q1\n> <!-- target: "alpha" -->\n> Answer one.\n`;
    const partial = `> [!USERNOTE] Q2\n> <!-- target: "alpha beta" -->\n> Answer two.\n`;
    const withBoth = `# Lesson\n\n${exact}\n${partial}\nTail.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withBoth, 'alpha');

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('Answer one.');
    expect(updatedMarkdown).toContain('Answer two.');
  });

  it('collapses a whitespace-only tail after a trailing note', () => {
    const note = `> [!USERNOTE] Q?\n> <!-- target: "Paragraph one." -->\n> A.\n`;
    const withNote = `Paragraph one.\n\n${note}\n\n\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withNote, 'Paragraph one.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).toBe('Paragraph one.\n');
  });

  it('removes an entire note whose answer quotes a note marker', () => {
    // The whole markered run is the stored answer — the reader's note pass
    // consumes a nested `> [!USERNOTE]` into the same card — so the deletion
    // must not stop at the nested marker.
    const note = [
      '> [!USERNOTE] Compare the two',
      '> <!-- target: "Paragraph one." -->',
      '> A nested marker follows:',
      '> [!USERNOTE] not a real note',
      '> End of answer.'
    ].join('\n');
    const withNote = `# Lesson\n\nParagraph one.\n\n${note}\n\nTail.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withNote, 'Paragraph one.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).not.toContain('USERNOTE');
    expect(updatedMarkdown).not.toContain('End of answer.');
    expect(updatedMarkdown).toBe('# Lesson\n\nParagraph one.\n\nTail.\n');
  });

  it('leaves an indented quote after the note alone', () => {
    const note = `> [!USERNOTE] Q?\n> <!-- target: "Paragraph one." -->\n> A.`;
    const withNote = `# Lesson\n\nParagraph one.\n\n${note}\n   > indented quote\n\nTail.\n`;

    const { updatedMarkdown, removed } = removeAnnotation(withNote, 'Paragraph one.');

    expect(removed).toBe(true);
    expect(updatedMarkdown).toBe('# Lesson\n\nParagraph one.\n\n   > indented quote\n\nTail.\n');
  });

  it('restores the original document after an insert/remove round trip', () => {
    const target = 'The Act states that "statutory discretion" applies broadly.';
    const { updatedMarkdown: withNote, success } = insertAnnotationAfterText(
      doc,
      target,
      noteMarkdown('Round trip?', target, 'Answer with a `code` span.')
    );
    expect(success).toBe(true);

    const { updatedMarkdown, removed } = removeAnnotation(withNote, target);

    expect(removed).toBe(true);
    expect(updatedMarkdown.trimEnd()).toBe(doc.trimEnd());
  });

  it('returns the input unchanged for empty arguments', () => {
    expect(removeAnnotation(doc, '')).toEqual({ updatedMarkdown: doc, removed: false });
    expect(removeAnnotation('', 'anything')).toEqual({ updatedMarkdown: '', removed: false });
  });
});
