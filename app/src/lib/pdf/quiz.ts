import type { Content } from 'pdfmake/build/pdfmake';
import { QuestionParser, type ParsedQuiz } from '../parser/questionParser';
import { box, dataTableLayout } from './box';
import { COLORS } from './theme';
import { renderMathToText } from './markdown/mathText';

/**
 * Compiles a KICA practice-test markdown document into a two-part exam:
 * Part 1 — the question sheet (numbered prompts + choice checkboxes),
 * Part 2 — the answer key grid + per-question rationales on a fresh page.
 */
export function compileQuizContent(markdown: string): Content[] {
  const quiz: ParsedQuiz = QuestionParser.parseMarkdown(markdown);
  const content: Content[] = [];

  content.push(
    {
      text: 'Practice Test',
      style: 'h1',
      margin: [0, 4, 0, 4]
    } as Content,
    {
      text: `Answer all ${quiz.questions.length} Ontario Curriculum KICA multiple-choice questions below. The Answer Key and detailed rationales are provided on the final page.`,
      style: 'body',
      color: COLORS.muted
    } as Content
  );

  for (const q of quiz.questions) {
    content.push(questionCard(q));
  }

  // Part 2: forced page break, then answer key + explanations
  content.push(...answerKeyContent(quiz));

  return content;
}

function questionCard(q: ParsedQuiz['questions'][number]): Content {
  const header: Content[] = [
    {
      columns: [
        { text: `Q${q.number}`, style: 'quizQNum', width: 34 },
        ...(q.category
          ? [
              {
                text: `[${q.category}]`,
                style: 'quizCategory',
                margin: [0, 1, 0, 0]
              } as Content
            ]
          : [])
      ],
      margin: [0, 0, 0, 3]
    } as Content
  ];

  const prompt: Content = {
    text: renderMathToText(q.prompt),
    style: 'quizPrompt',
    margin: [0, 0, 0, 7]
  } as Content;

  const options = q.options.map((opt) => ({
    text: [
      { text: '☐  ', color: COLORS.faint },
      { text: `${opt.letter}. `, bold: true },
      renderMathToText(opt.text)
    ],
    style: 'quizOption',
    margin: [10, 0, 0, 3]
  })) as Content[];

  return box([...header, prompt, ...options], {
    borderColor: COLORS.border,
    padding: [10, 9, 10, 10]
  });
}

function answerKeyContent(quiz: ParsedQuiz): Content[] {
  const content: Content[] = [];

  content.push({
    text: 'Answer Key & Detailed Explanations',
    style: 'h1',
    pageBreak: 'before',
    margin: [0, 0, 0, 4]
  } as Content);

  content.push({
    text: 'Verify your solutions against the Ontario curriculum expectations.',
    style: 'body',
    color: COLORS.muted,
    margin: [0, 0, 0, 12]
  } as Content);

  // Summary grid: 6 answers per row
  const perRow = 6;
  const rows: Content[][] = [];
  for (let i = 0; i < quiz.questions.length; i += perRow) {
    rows.push(
      quiz.questions.slice(i, i + perRow).map((q) => ({
        text: [
          { text: `Q${q.number}  `, color: COLORS.muted },
          { text: q.correctAnswer || '—', bold: true, color: q.correctAnswer ? COLORS.answerGreen : COLORS.muted }
        ],
        alignment: 'center' as const,
        fontSize: 9.5
      })) as Content[]
    );
  }
  while (rows.length > 0 && rows[rows.length - 1].length < perRow) {
    rows[rows.length - 1].push({ text: '' } as Content);
  }

  content.push({
    table: {
      widths: Array.from({ length: perRow }, () => '*'),
      body: rows
    },
    layout: dataTableLayout(),
    margin: [0, 0, 0, 16]
  } as Content);

  content.push({
    text: 'Explanations & Rationales',
    style: 'h2',
    margin: [0, 6, 0, 8]
  } as Content);

  for (const q of quiz.questions) {
    const inner: Content[] = [
      {
        columns: [
          { text: `Q${q.number}`, style: 'quizQNum', width: 30 },
          {
            text: [
              { text: 'Correct Answer: ', color: COLORS.muted },
              { text: q.correctAnswer || '—', bold: true, color: q.correctAnswer ? COLORS.answerGreen : COLORS.muted }
            ],
            fontSize: 9,
            margin: [0, 1, 0, 0]
          },
          ...(q.category
            ? [{ text: `[${q.category}]`, style: 'quizCategory', margin: [6, 2, 0, 0] } as Content]
            : [])
        ],
        margin: [0, 0, 0, 3]
      } as Content,
      {
        text: renderMathToText(q.prompt),
        style: 'quizPrompt',
        fontSize: 9.5,
        margin: [0, 0, 0, 5]
      } as Content
    ];

    if (q.explanation) {
      inner.push({
        text: renderMathToText(q.explanation),
        style: 'body',
        fontSize: 9.5,
        color: COLORS.ink,
        margin: [0, 0, 0, 0]
      } as Content);
    }

    content.push(box(inner, { fill: COLORS.softFill, borderColor: COLORS.border, padding: [8, 7, 8, 9] }));
  }

  return content;
}
