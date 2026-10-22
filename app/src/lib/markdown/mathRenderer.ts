import katex from 'katex';
import { Marked } from 'marked';

const inlineMarked = new Marked({ gfm: true, breaks: true });

export interface MathToken {
  id: string;
  math: string;
  display: boolean;
}

/**
 * Determines whether text between $...$ delimiters is genuinely LaTeX / mathematical notation
 * and NOT plain text or accounting currency (e.g. "$1500 and then $2500").
 *
 * Math-structure evidence (LaTeX commands, exponents, subscripts, TeX grouping, relations)
 * is checked BEFORE the currency/prose guards so digit-leading expressions like
 * `$30^\circ$` or `$2^3 = 8$` still render. Content that carries no such structure
 * and starts with a digit/comma ("5,000", "1,500.50") remains currency.
 */
export function isLikelyInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  // 1. Explicit LaTeX commands: \frac, \sqrt, \alpha, \sum, \neq, \times, etc.
  if (/\\[a-zA-Z]+/.test(trimmed)) return true;

  // 2. Mathematical structural notation: exponents (^), subscripts (_), or TeX grouping ({})
  if (/[\^_{}]/.test(trimmed)) return true;

  // 3. TeX escaped symbols or unicode math symbols
  if (/\\([\\$&#%_{}[\]|<>~^+-/*=])/.test(trimmed)) return true;
  if (/[≠≈≤≥±×÷·√∞∫∑∏∂∇∈∉⊂⊃∪∩∧∨]/.test(trimmed)) return true;

  // 4. Symbolic expressions with a relation or variable: $x = 2$, $a + b = c$, $1 + 1 = 2$.
  //    A lone operator between digits ("5+") is too currency-adjacent to accept.
  if (
    /[=<>+*]/.test(trimmed) &&
    (/[=<>]/.test(trimmed) || /[a-zA-Z]/.test(trimmed)) &&
    !/[a-zA-Z]{3,}/.test(trimmed)
  ) {
    return true;
  }

  // 5. Single algebraic variable: $x$, $y$, $z$, $n$, $t$, $k$
  if (/^[a-zA-Z]$/.test(trimmed)) return true;

  // 6. Numeric coefficient with a variable ($5x$, $2n$) — but not $5k/$2m/$3b,
  //    where the trailing letter reads as a currency magnitude (thousand/million/billion).
  if (/^\d+(?:\.\d+)?[a-zA-Z]$/.test(trimmed) && !/[kmb]$/i.test(trimmed)) return true;

  // 7. Comma-separated single-letter lists: $a, k, d, c$
  if (/^[a-zA-Z](?:\s*,\s*[a-zA-Z])+$/.test(trimmed)) return true;

  // 8. Currency / plain-prose guards (applied only when no math structure matched above)
  if (/^[\d,.]/.test(trimmed)) return false;
  if (/\b(and|then|the|or|of|in|to|for|with|by|at|from|is|are|was|were|assets|cash|debt|revenue|cost|expense|expenses|inventory)\b/i.test(trimmed)) {
    return false;
  }
  if (/[a-zA-Z]{3,}/.test(trimmed)) {
    return false;
  }
  if (/\b[a-zA-Z]{2,}\s+[a-zA-Z]{2,}\b/.test(trimmed)) {
    return false;
  }

  return false;
}

/**
 * Extracts and replaces mathematical expressions from markdown text into placeholder tokens
 * BEFORE Markdown parsing, so marked never strips backslashes (\(), breaks underscores into <em>,
 * or splits math in tables.
 */
export function extractMathFromMarkdown(markdown: string): {
  processedMarkdown: string;
  mathTokens: MathToken[];
} {
  const mathTokens: MathToken[] = [];

  // Protect pre and code blocks so code snippets are never interpreted as math
  const codeBlocks: string[] = [];
  let cleaned = markdown.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    codeBlocks.push(match);
    return `%%%MATH_CODE_${codeBlocks.length - 1}%%%`;
  });

  // 1. Display math: $$...$$
  cleaned = cleaned.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: math.trim(),
      display: true
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 2. LaTeX Display math: \[...\]
  cleaned = cleaned.replace(/\\\[([\s\S]+?)\\\]/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: math.trim(),
      display: true
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 3. LaTeX Inline math: \(...\)
  cleaned = cleaned.replace(/\\\(([\s\S]+?)\\\)/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: math.trim(),
      display: false
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 4. Inline dollar math: $...$ with strict accounting currency guards
  // Opening $ cannot be preceded by word char or backslash and cannot be followed by a space;
  // digits ARE allowed after the opening $ so $30^\circ$-style math matches — the
  // isLikelyInlineMath currency guards below decide whether it renders.
  // Closing $ cannot be preceded by space, cannot be followed by digit.
  cleaned = cleaned.replace(/(?<![\w\\])\$(?!\s)([^\$\n]+?)(?<!\s)\$(?!\d)/g, (match, math) => {
    if (isLikelyInlineMath(math)) {
      mathTokens.push({
        id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
        math: math.trim(),
        display: false
      });
      return mathTokens[mathTokens.length - 1].id;
    }
    return match;
  });

  // 5. Parenthesized LaTeX expressions: ( ... ) with balanced inner parentheses
  // Matches expressions like:
  //   (\frac{P(x)}{Q(x)})
  //   (Q(x)\neq0)
  //   (\frac{x^m}{x^n}=x^{m-n})
  //   (x^{-n}=\frac{1}{x^n})
  let res = '';
  let i = 0;
  while (i < cleaned.length) {
    // A "(" directly after "]" is a markdown link/image destination — never math,
    // even when the URL contains _ or / that would otherwise look like notation.
    if (cleaned[i] === '(' && cleaned[i - 1] !== ']') {
      let depth = 1;
      let j = i + 1;
      while (j < cleaned.length && depth > 0 && cleaned[j] !== '\n') {
        if (cleaned[j] === '\\') {
          j += 2;
          continue;
        }
        if (cleaned[j] === '(') depth++;
        else if (cleaned[j] === ')') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = cleaned.slice(i + 1, j - 1).trim();
        // Check if inner content contains explicit LaTeX commands or notation
        // and is not plain English prose inside parentheses
        const hasLatex = /\\[a-zA-Z]+/.test(inner);
        const hasExponentFraction = /[\^_{}]/.test(inner) && /[=+\-*/]/.test(inner);
        const isNotProse = !/\b(and|or|the|in|at|for|with|by|from|note|see)\b/i.test(inner);

        if ((hasLatex || hasExponentFraction) && isNotProse) {
          mathTokens.push({
            id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
            math: inner,
            display: false
          });
          res += mathTokens[mathTokens.length - 1].id;
          i = j;
          continue;
        }
      }
    }
    res += cleaned[i];
    i++;
  }
  cleaned = res;

  // Restore protected code blocks
  cleaned = cleaned.replace(/%%%MATH_CODE_(\d+)%%%/g, (_, idx) => codeBlocks[Number(idx)] || '');

  return {
    processedMarkdown: cleaned,
    mathTokens
  };
}

/**
 * Restores math placeholder tokens into KaTeX rendered HTML.
 */
export function restoreMathTokens(html: string, mathTokens: MathToken[]): string {
  if (!mathTokens.length) return html;

  return html.replace(/%%%MATH_TOKEN_(\d+)%%%/g, (match, idx) => {
    const token = mathTokens[Number(idx)];
    if (!token) return match;

    try {
      return katex.renderToString(token.math, {
        displayMode: token.display,
        throwOnError: false
      });
    } catch {
      return token.math;
    }
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders plain text or quiz questions/options/explanations that contain
 * LaTeX math and inline markdown (**bold**, *italic*, `code`, tables)
 * into HTML that is safe to inject with {@html}:
 * math is extracted first, non-math text is HTML-escaped, markdown elements
 * (such as **bold**) are parsed, and math placeholders are restored as KaTeX HTML.
 */
export function renderTextWithMath(text: string): string {
  if (!text) return '';
  const { processedMarkdown, mathTokens } = extractMathFromMarkdown(text);
  const escaped = escapeHtml(processedMarkdown);
  let parsed = escaped;
  try {
    if (!text.includes('\n') && !text.includes('|')) {
      parsed = inlineMarked.parseInline(escaped) as string;
    } else {
      parsed = inlineMarked.parse(escaped) as string;
    }
  } catch {
    parsed = escaped;
  }
  return restoreMathTokens(parsed, mathTokens);
}
