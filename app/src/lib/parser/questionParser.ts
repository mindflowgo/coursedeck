import { parseFrontmatter } from './frontmatter';

export interface QuestionOption {
  letter: string;
  text: string;
}

export interface QuizQuestion {
  number: string; // e.g. "01"
  category?: string; // e.g. "Knowledge & Understanding"
  type?: 'multiple-choice' | 'fill-in-the-blank' | 'short-answer';
  prompt: string;
  options: QuestionOption[];
  correctAnswer: string; // e.g. "B" or text answer / rubric
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

    // 2. Identify Answers section (exclude legacy "Fill-in-the-Blank Answers" which has its own format)
    const answersHeaderMatch = body.match(
      /(?:^|\n)##\s+(?!Fill-in-the-Blank)(?:Answers?(?:\s*&|\s+and|\s+Key|\s+Detailed|\s+Solutions?)?|Answer Key|Solutions?)\b[^\n]*/i
    );

    let questionsEndIndex = answersHeaderMatch && answersHeaderMatch.index !== undefined
      ? answersHeaderMatch.index
      : body.length;

    // In legacy files with a separate "## Fill-in-the-Blank Answers" section, exclude that legacy block from MC questions
    const legacyAnswersMatch = body.match(/(?:^|\n)##\s+Fill-in-the-Blank Answers\b/i);
    const legacyQuestionsMatch = body.match(/(?:^|\n)##\s+Fill-in-the-Blank Questions\b/i);
    if (legacyAnswersMatch && legacyQuestionsMatch && legacyQuestionsMatch.index !== undefined) {
      const qStart = body.search(/(?:^|\n)##\s+Questions\b/i);
      if (legacyQuestionsMatch.index > (qStart >= 0 ? qStart : 0)) {
        questionsEndIndex = Math.min(questionsEndIndex, legacyQuestionsMatch.index);
      }
    }

    const questionsText = body.substring(0, questionsEndIndex);

    // 3. Parse Answers map from the answers section
    const answerMap = new Map<string, { letter: string; explanation: string }>();
    const answersList: Array<{ num: string; letter: string; explanation: string }> = [];

    if (answersHeaderMatch && answersHeaderMatch.index !== undefined) {
      const startIdx = answersHeaderMatch.index + answersHeaderMatch[0].length;
      const rest = body.substring(startIdx);
      const nextSectionMatch = rest.match(/(?:^|\n)##\s+(?!#)/);
      const answersText = nextSectionMatch && nextSectionMatch.index !== undefined
        ? rest.substring(0, nextSectionMatch.index)
        : rest;

      // Robust regex for answer entries:
      // Matches question numbers with optional bullets and bold: e.g. "01)", "- **13)**", "**15) ...", "1."
      const entryRegex = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(\d+)[\).:]\s*(?:\*\*)?\s*([\s\S]*?)(?=(?:\n\s*(?:[-*]\s*)?(?:\*\*)?\d+[\).:]|\n##\s+(?!#)|$))/g;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = entryRegex.exec(answersText)) !== null) {
        const numPadded = aMatch[1].padStart(2, '0');
        const numRaw = parseInt(aMatch[1], 10).toString();
        const rawBody = aMatch[2].trim();

        let answerText = rawBody;
        let explanation = '';

        // 1. Multiple-choice letter format: e.g. "**B** — ...", "B - ...", "**B**."
        const mcMatch = rawBody.match(/^(?:(?:Option|Correct Answer:?|Answer:?)\s*)?(?:\*\*)?([A-Da-d])(?:\*\*)?\s*(?:[-–—:]|\.|\))\s*([\s\S]*)$/);
        if (mcMatch) {
          answerText = mcMatch[1].toUpperCase();
          explanation = mcMatch[2].trim().replace(/^\(?explanation\)?:?\s*/i, '').replace(/^\(?rationale\)?:?\s*/i, '');
        } else {
          // 2. Dash separated format: "Answer - (explanation) ..." or "[Answer] - ..."
          const dashMatch = rawBody.match(/^([^\-–—\n]+?)\s*[-–—]\s*([\s\S]*)$/);
          if (dashMatch) {
            answerText = dashMatch[1].replace(/^[\*\_\[\(]+/, '').replace(/[\*\_\]\)\.]+$/, '').trim();
            explanation = dashMatch[2].trim()
              .replace(/^\(?explanation\)?:?\s*/i, '')
              .replace(/^\(?rationale\)?:?\s*/i, '')
              .replace(/^\(?rubric\)?:?\s*/i, '');
          } else {
            // 3. Open-ended / model response without dash (e.g. bold terms or full rubric)
            const boldMatches = Array.from(rawBody.matchAll(/\*\*([^*]+)\*\*/g)).map((m) => m[1].trim());
            answerText = boldMatches.length > 0 ? boldMatches.join(', ') : rawBody.split('\n')[0].replace(/^[\*\_#]+/, '').trim();
            explanation = rawBody;
          }
        }

        const entry = { num: numPadded, letter: answerText, explanation };
        answersList.push(entry);
        answerMap.set(numPadded, entry);
        if (numRaw !== numPadded) {
          answerMap.set(numRaw, entry);
        }
      }
    }

    // 4. Parse Questions blocks
    const rawBlocks = questionsText.split(/--+/);
    const questionBlocks: string[] = [];

    // Detect top-level question markers (e.g. "01)", "02)", "12)", "1)", "01.")
    // Avoid splitting on inner numbered lists like "1. ", "2. " inside a prompt
    const qSplitRegex = /(?=(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:0\d|\d{2,})[\).:]\s*(?:\*\*)?|(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\d+\)\s*(?:\*\*)?)/;
    const qDetectRegex = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:0\d|\d{2,})[\).:]\s*(?:\*\*)?|(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\d+\)\s*(?:\*\*)?/g;

    for (const raw of rawBlocks) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const numMatches = Array.from(trimmed.matchAll(qDetectRegex));
      if (numMatches.length > 1) {
        const subBlocks = trimmed.split(qSplitRegex);
        for (const sub of subBlocks) {
          if (sub.trim()) questionBlocks.push(sub.trim());
        }
      } else {
        questionBlocks.push(trimmed);
      }
    }

    for (const block of questionBlocks) {
      const trimmedBlock = block.trim();
      const qNumMatch = trimmedBlock.match(
        /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(\d+)[\).:]\s*(?:\*\*)?\s*(?:\[(.*?)\])?(?:\*\*)?\s*([\s\S]*?)(?=<Multiple-Choice>|<\/Multiple-Choice>|\n- \[[ xX]\]|$)/i
      );
      if (!qNumMatch) continue;

      let num = qNumMatch[1].padStart(2, '0');
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

      // If num is already in questions (duplicate numbering in separate sections),
      // re-index to sequential number so keys do not collide
      if (questions.some((q) => q.number === num)) {
        num = String(questions.length + 1).padStart(2, '0');
      }

      // Look up answer from answerMap (try padded, raw, or sequential index)
      const answerInfo = answerMap.get(num) || answerMap.get(parseInt(num, 10).toString()) || answersList[questions.length];

      // Fallback 1: check if an option was marked with [x]
      // Fallback 2: check for inline "Answer: B" inside question block
      let inlineAnswer: string | null = null;
      const inlineMatch = trimmedBlock.match(/(?:^|\n)\s*(?:Answer|Correct Answer):\s*(?:\*{1,2}|\[)?([A-Da-d])(?:\*{1,2}|\])?/i);
      if (inlineMatch) {
        inlineAnswer = inlineMatch[1].toUpperCase();
      }

      let correctAnswer = answerInfo?.letter || checkedLetter || inlineAnswer || '';
      const isFillIn = options.length === 0 && (prompt.includes('___') || /fill[- ]in/i.test(category || ''));
      const isShortAnswer = options.length === 0 && !isFillIn && prompt.trim().length > 0;

      if (isShortAnswer && /^(?:expected criteria|rubric|model response|criteria)/i.test(correctAnswer) && answerInfo?.explanation) {
        correctAnswer = `${correctAnswer} — ${answerInfo.explanation}`;
      }

      const qType: 'multiple-choice' | 'fill-in-the-blank' | 'short-answer' =
        options.length > 0
          ? 'multiple-choice'
          : isFillIn
            ? 'fill-in-the-blank'
            : 'short-answer';

      if (options.length > 0 || isFillIn || isShortAnswer) {
        questions.push({
          number: num,
          category,
          type: qType,
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
