import { parseFrontmatter } from './frontmatter';

export interface QuestionOption {
  letter: string;
  text: string;
}

export interface QuizQuestion {
  number: string; // e.g. "01"
  category?: string; // e.g. "Knowledge & Understanding"
  type?: 'multiple-choice' | 'fill-in-the-blank';
  prompt: string;
  options: QuestionOption[];
  correctAnswer: string; // e.g. "B" or text answer
  explanation?: string;
}

export interface ParsedQuiz {
  courseCode?: string;
  title: string;
  questions: QuizQuestion[];
}

export class QuestionParser {
  /**
   * Parse standardized KICA markdown into structured Quiz object
   */
  static parseMarkdown(markdown: string): ParsedQuiz {
    const { body } = parseFrontmatter(markdown);
    const lines = body.split('\n');
    let courseCode = '';
    let title = '';
    const questions: QuizQuestion[] = [];

    // 1. Parse header from body before ## Questions
    for (let i = 0; i < Math.min(lines.length, 25); i++) {
      const line = lines[i].trim();
      if (line.toLowerCase().startsWith('## questions')) {
        break;
      }
      if (line.toLowerCase().startsWith('course:')) {
        courseCode = line.replace(/course:\s*/i, '').trim();
      } else if (line.startsWith('# ') && !title) {
        title = line.replace(/^#\s+/, '').trim();
      }
    }

    // 2. Identify Multiple-Choice Answers section
    // Exclude 'Fill-in-the-Blank' headers from matching as MC answers
    const answersHeaderMatch = body.match(
      /(?:^|\n)##\s+(?!Fill-in-the-Blank)(?:Answers?(?:\s*&|\s+and|\s+Key|\s+Detailed|\s+Solutions?)?|Answer Key|Solutions?)\b[^\n]*/i
    );

    // Questions section ends at the earliest of: MC answers header or other non-question ## headers
    const otherSectionMatch = body.match(
      /(?:^|\n)##\s+(?:Fill-in-the-Blank|Comprehensive Short Answer|Case Problems)\b[^\n]*/i
    );

    let questionsEndIndex = body.length;
    if (answersHeaderMatch && answersHeaderMatch.index !== undefined) {
      questionsEndIndex = Math.min(questionsEndIndex, answersHeaderMatch.index);
    }
    if (otherSectionMatch && otherSectionMatch.index !== undefined) {
      const questionsHeaderMatch = body.match(/(?:^|\n)##\s+Questions\b/i);
      const qStart = questionsHeaderMatch?.index ?? 0;
      if (otherSectionMatch.index > qStart) {
        questionsEndIndex = Math.min(questionsEndIndex, otherSectionMatch.index);
      }
    }

    const questionsText = body.substring(0, questionsEndIndex);

    // 3. Parse Answers map from the MC answers section
    const answerMap = new Map<string, { letter: string; explanation: string }>();
    if (answersHeaderMatch && answersHeaderMatch.index !== undefined) {
      const startIdx = answersHeaderMatch.index + answersHeaderMatch[0].length;
      const rest = body.substring(startIdx);
      const nextSectionMatch = rest.match(/(?:^|\n)##\s+/);
      const answersText = nextSectionMatch && nextSectionMatch.index !== undefined
        ? rest.substring(0, nextSectionMatch.index)
        : rest;

      // Robust regex for answer entries:
      // - Question number: e.g. "01)", "1.", "01:"
      // - Handles MC answers (A-D) as well as text answers for fill-in-the-blank
      // - Explanations with or without "(explanation)"
      const entryRegex = /(?:^|\n)\s*(\d+)[\).:]\s*(?:(?:Option|Correct Answer:?|Answer:?)\s*)?([^\n]+)/gi;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = entryRegex.exec(answersText)) !== null) {
        const numPadded = aMatch[1].padStart(2, '0');
        const numRaw = parseInt(aMatch[1], 10).toString();
        const line = aMatch[2].trim();

        let answerText = line;
        let explanation = '';

        // Match "- (explanation) ...", "— (explanation) ...", or " - explanation"
        const explMatch = line.match(/^([^\-–—:]+)(?:\s*[-–—:]\s*(?:\(?explanation\)?:?)?\s*(.*))$/i);
        if (explMatch) {
          answerText = explMatch[1].trim();
          explanation = explMatch[2].trim();
        } else {
          const dashMatch = line.match(/^([^\s\-–—:]+)\s*[-–—:]\s*(.*)$/);
          if (dashMatch) {
            answerText = dashMatch[1].trim();
            explanation = dashMatch[2].trim().replace(/^\(?explanation\)?:?\s*/i, '');
          }
        }

        let cleaned = answerText.replace(/^[\*\_\[\(]+/, '').replace(/[\*\_\]\)\.]+$/, '').trim();
        if (/^[a-d]$/i.test(cleaned)) {
          cleaned = cleaned.toUpperCase();
        }

        answerMap.set(numPadded, { letter: cleaned, explanation });
        if (numRaw !== numPadded) {
          answerMap.set(numRaw, { letter: cleaned, explanation });
        }
      }
    }

    // 4. Parse Questions blocks
    let questionBlocks = questionsText.split(/--+/);
    if (questionBlocks.length <= 1 && /- \[[ xX]\]/.test(questionsText)) {
      const parts = questionsText.split(/(?=(?:^|\n)\s*\d+[\).:]\s*(?:\[.*?\])?)/);
      if (parts.length > 1) {
        questionBlocks = parts;
      }
    }

    for (const block of questionBlocks) {
      const trimmedBlock = block.trim();
      const qNumMatch = trimmedBlock.match(
        /(?:^|\n)\s*(\d+)[\).:]\s*(?:\[(.*?)\])?\s*([\s\S]*?)(?=<Multiple-Choice>|<\/Multiple-Choice>|\n- \[[ xX]\]|$)/i
      );
      if (!qNumMatch) continue;

      const num = qNumMatch[1].padStart(2, '0');
      const category = qNumMatch[2]?.trim();
      let prompt = qNumMatch[3]?.trim() || '';
      // Remove any <Multiple-Choice> or </Multiple-Choice> tags
      prompt = prompt.replace(/<\/?Multiple-Choice>/gi, '').trim();

      // Parse options
      const options: QuestionOption[] = [];
      let checkedLetter: string | null = null;
      const optionMatches = trimmedBlock.match(/- \[[ xX]\]\s*(.*)/g);
      if (optionMatches) {
        optionMatches.forEach((optLine, idx) => {
          const isChecked = /^- \[[xX]\]/.test(optLine);
          let optText = optLine.replace(/^- \[[ xX]\]\s*/, '').trim();
          const letter = String.fromCharCode(65 + idx); // A, B, C, D
          if (isChecked) {
            checkedLetter = letter;
          }
          // Strip duplicate option letter prefix if present (e.g. 'A) Text' or 'A. Text')
          optText = optText.replace(/^[A-Da-d][\).:]\s*/, '').trim();
          options.push({ letter, text: optText });
        });
      }

      // Look up answer from answerMap (try padded and raw)
      const answerInfo = answerMap.get(num) || answerMap.get(parseInt(num, 10).toString());

      // Fallback 1: check if an option was marked with [x]
      // Fallback 2: check for inline "Answer: B" inside question block
      let inlineAnswer: string | null = null;
      const inlineMatch = trimmedBlock.match(/(?:^|\n)\s*(?:Answer|Correct Answer):\s*(?:\*{1,2}|\[)?([A-Da-d])(?:\*{1,2}|\])?/i);
      if (inlineMatch) {
        inlineAnswer = inlineMatch[1].toUpperCase();
      }

      const correctAnswer = answerInfo?.letter || checkedLetter || inlineAnswer || '';
      const isFillIn = options.length === 0 && (prompt.includes('___') || /fill[- ]in/i.test(category || ''));

      if (options.length > 0 || isFillIn) {
        questions.push({
          number: num,
          category,
          type: isFillIn ? 'fill-in-the-blank' : 'multiple-choice',
          prompt,
          options,
          correctAnswer,
          explanation: answerInfo?.explanation || ''
        });
      }
    }

    return {
      courseCode,
      title: title || 'Practice Quiz',
      questions
    };
  }

  /**
   * Serialize structured Quiz object back to standardized markdown
   */
  static serializeToMarkdown(quiz: ParsedQuiz): string {
    let md = '';
    if (quiz.courseCode) {
      md += `course: ${quiz.courseCode}\n\n`;
    }
    md += `# ${quiz.title}\n\n`;
    md += `## Questions\n`;

    for (const q of quiz.questions) {
      const categoryPart = q.category ? `[${q.category}] ` : '';
      md += `${q.number}) ${categoryPart}${q.prompt}\n`;
      if (q.options && q.options.length > 0) {
        md += `<Multiple-Choice>\n`;
        for (const opt of q.options) {
          md += `- [ ] ${opt.text}\n`;
        }
      }
      md += `\n--\n\n`;
    }

    md += `## Answers\n`;
    for (const q of quiz.questions) {
      const explanationPart = q.explanation ? ` - (explanation) ${q.explanation}` : '';
      md += `${q.number}) ${q.correctAnswer}${explanationPart}\n`;
    }

    return md;
  }
}
