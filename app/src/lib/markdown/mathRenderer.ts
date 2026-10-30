import katex from 'katex';
import { Marked } from 'marked';

const inlineMarked = new Marked({ gfm: true, breaks: true });

export interface MathToken {
  id: string;
  math: string;
  display: boolean;
}

/**
 * Normalizes ASCII and plain-text math notation (e.g. from backtick expressions or LLM summaries)
 * into standard LaTeX syntax compatible with KaTeX.
 *
 * Examples:
 * - "b^(x+y)" -> "b^{x+y}"
 * - "2^7 · 2^5 = 2^12" -> "2^7 \cdot 2^5 = 2^{12}"
 * - "√12 = 2√3" -> "\sqrt{12} = 2\sqrt{3}"
 * - "x^(1/n) = n√x" -> "x^{1/n} = \sqrt[n]{x}"
 * - "b ≠ 0" -> "b \neq 0"
 * - "-b^4 = -(b^4)" -> "-b^4 = -(b^4)"
 */
export function normalizeMathToLatex(expr: string): string {
  let s = expr.trim();

  // 1. Unicode minus, dashes, arrows, relations, arithmetic operators
  s = s.replace(/−/g, '-');
  s = s.replace(/·/g, ' \\cdot ');
  s = s.replace(/×/g, ' \\times ');
  s = s.replace(/÷/g, ' \\div ');
  s = s.replace(/≠/g, ' \\neq ');
  s = s.replace(/≥/g, ' \\ge ');
  s = s.replace(/≤/g, ' \\le ');
  s = s.replace(/≈/g, ' \\approx ');
  s = s.replace(/±/g, ' \\pm ');
  s = s.replace(/→/g, ' \\rightarrow ');
  s = s.replace(/←/g, ' \\leftarrow ');
  s = s.replace(/⇒/g, ' \\implies ');
  s = s.replace(/⇔/g, ' \\iff ');

  // 2. Unicode superscripts to ^...
  const unicodeSuperscripts: Record<string, string> = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    '⁺': '+', '⁻': '-', 'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x', 'ʸ': 'y'
  };
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿⁱˣʸ]+/g, (match) => {
    const converted = match.split('').map((ch) => unicodeSuperscripts[ch] || ch).join('');
    return converted.length > 1 ? `^{${converted}}` : `^${converted}`;
  });

  // 3. Greek letters (isolated or with math symbols)
  s = s.replace(/\bθ\b|θ/g, ' \\theta ');
  s = s.replace(/\bπ\b|π/g, ' \\pi ');
  s = s.replace(/\bα\b|α/g, ' \\alpha ');
  s = s.replace(/\bβ\b|β/g, ' \\beta ');
  s = s.replace(/\bγ\b|γ/g, ' \\gamma ');
  s = s.replace(/\bλ\b|λ/g, ' \\lambda ');
  s = s.replace(/\bμ\b|μ/g, ' \\mu ');
  s = s.replace(/\bσ\b|σ/g, ' \\sigma ');
  s = s.replace(/\bω\b|ω/g, ' \\omega ');
  s = s.replace(/\bΔ\b|Δ/g, ' \\Delta ');

  // 4. Square roots and nth roots:
  // e.g., n√(x^a) -> \sqrt[n]{x^a}, n√x -> \sqrt[n]{x}
  s = s.replace(/([a-zA-Z])√\(([^)]+)\)/g, '\\sqrt[$1]{$2}');
  s = s.replace(/([a-zA-Z])√([a-zA-Z0-9]+)/g, '\\sqrt[$1]{$2}');
  // General square roots: √12 -> \sqrt{12}, √(ab) -> \sqrt{ab}
  s = s.replace(/√\(([^)]+)\)/g, '\\sqrt{$1}');
  s = s.replace(/√([a-zA-Z0-9]+)/g, '\\sqrt{$1}');

  // 5. Exponents:
  // Parenthesized exponents: ^(...) -> ^{...} e.g. b^(x+y) -> b^{x+y}, 81^(3/2) -> 81^{3/2}
  s = s.replace(/\^\(([^)]+)\)/g, '^{$1}');

  // Multi-digit or negative-digit exponents without braces: e.g. 2^12 -> 2^{12}, 10^-5 -> 10^{-5}
  s = s.replace(/\^(\d{2,}|-\d+)/g, '^{$1}');

  // 6. Common functions: sin, cos, tan when followed by a variable/expression
  s = s.replace(/\b(sin|cos|tan|cot|sec|csc|log|ln)\b(?!\s*[\w(]*\s*=[^=])/g, '\\$1');

  // Clean up excessive whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Checks whether text inside backticks is a software code snippet rather than math.
 */
export function isCodeSnippet(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;

  // 1. Programming keywords
  if (/\b(const|let|var|function|class|return|import|export|from|default|if|else|for|while|switch|case|break|continue|new|this|typeof|instanceof|void|async|await|try|catch|finally|throw|yield|package|interface|type|public|private|protected|readonly|enum|namespace|def|elif|lambda|echo|print|console)\b/.test(trimmed)) {
    return true;
  }

  // 2. CLI commands
  if (/\b(npm|bun|pnpm|yarn|npx|git|sudo|cd|ls|mkdir|rm|cp|mv|chmod|chown|curl|wget|grep|docker|kubectl)\b/.test(trimmed)) {
    return true;
  }

  // 3. File extensions or paths
  if (/\.(ts|js|jsx|tsx|json|svelte|vue|html|css|scss|py|rs|go|c|cpp|h|java|rb|php|sh|md|yml|yaml|toml|lock)\b/.test(trimmed)) {
    return true;
  }
  if (/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(trimmed)) {
    return true;
  }

  // 4. HTML/XML tags
  if (/^<[\s\S]+>$/.test(trimmed) || /<\/[a-zA-Z]+>/.test(trimmed)) {
    return true;
  }

  // 5. Code operators / syntax (===, !==, &&, ||, =>, etc.)
  if (/(===|!==|&&|\|\||=>|\+\+|--|\+=|-=|\*=|\/=)/.test(trimmed)) {
    return true;
  }

  // 6. String literals in quotes
  if (/^["'].*["']$/.test(trimmed)) {
    return true;
  }

  // 7. CLI flags (e.g. --flag, --save-dev)
  if (/^--[a-zA-Z0-9]/.test(trimmed)) {
    return true;
  }

  // 8. HTML attributes or CSS properties: e.g. class="...", style="..."
  if (/\b(class|style|id|href|src)=["']/.test(trimmed)) {
    return true;
  }

  // 9. Method invocation on an identifier: e.g. obj.method() or console.log()
  if (/\b[a-zA-Z_]\w*\.[a-zA-Z_]\w*\(/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Determines whether text between $...$ or `...` delimiters is genuinely LaTeX / mathematical notation
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

  // 3. TeX escaped symbols or unicode math symbols, Greek letters, superscripts, arrows
  if (/\\([\\$&#%_{}[\]|<>~^+-/*=])/.test(trimmed)) return true;
  if (/[≠≈≤≥±×÷·√∞∫∑∏∂∇∈∉⊂⊃∪∩∧∨→←⇒⇔θπμβγαδλεσλωΔΩΦ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿⁱ]/.test(trimmed)) return true;

  // 4. Common mathematical functions: sin, cos, tan, log, ln
  if (/\b(sin|cos|tan|cot|sec|csc|log|ln|arcsin|arccos|arctan)\b/.test(trimmed)) return true;

  // 5. Binary arithmetic operations between alphanumeric tokens or parens: e.g. p/q, x/k, a + b, x - y
  if (/[a-zA-Z0-9)\]]\s*[\/+\-*−–]\s*[a-zA-Z0-9(\[]/.test(trimmed) && !/[a-zA-Z]{4,}/.test(trimmed)) {
    return true;
  }

  // 6. Symbolic expressions with an explicit relation: $x = 2$, $a < b$, $y = f(x)$, $1 + 1 = 2$
  if (
    /[=<>≤≥≠≈→←⇒⇔]/.test(trimmed) &&
    (/[a-zA-Z]/.test(trimmed) || /\d/.test(trimmed)) &&
    !/[a-zA-Z]{4,}/.test(trimmed)
  ) {
    return true;
  }

  // 7. Single algebraic variable with optional unicode sign: $x$, $y$, $z$, $n$, $−r$
  if (/^[a-zA-Z]$/.test(trimmed) || /^[+−][a-zA-Z]$/.test(trimmed)) return true;

  // 8. Numeric coefficient with a variable ($5x$, $2n$) — but not $5k/$2m/$3b
  if (/^[+-]?\d+(?:\.\d+)?[a-zA-Z]$/.test(trimmed) && !/[kmb]$/i.test(trimmed)) return true;

  // 9. Comma-separated single-letter lists: $a, k, d, c$
  if (/^[a-zA-Z](?:\s*,\s*[a-zA-Z])+$/.test(trimmed)) return true;

  // 10. Currency / plain-prose guards (applied only when no math structure matched above)
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
  const codeBlocks: string[] = [];

  // 1. Protect multi-line fenced code blocks (``` ... ```) so code blocks are never interpreted as math
  let cleaned = markdown.replace(/(```+[\s\S]*?```+)/g, (match) => {
    codeBlocks.push(match);
    return `%%%MATH_CODE_${codeBlocks.length - 1}%%%`;
  });

  // 2. Inline backticks: if the content is mathematical notation and not a code snippet,
  // extract it into a MathToken with proper LaTeX normalization so KaTeX renders it.
  cleaned = cleaned.replace(/`([^`\n]+)`/g, (match, inner) => {
    const trimmed = inner.trim();
    if (!isCodeSnippet(trimmed) && isLikelyInlineMath(trimmed)) {
      const normalized = normalizeMathToLatex(trimmed);
      mathTokens.push({
        id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
        math: normalized,
        display: false
      });
      return mathTokens[mathTokens.length - 1].id;
    }
    codeBlocks.push(match);
    return `%%%MATH_CODE_${codeBlocks.length - 1}%%%`;
  });

  // 3. Display math: $$...$$
  cleaned = cleaned.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: normalizeMathToLatex(math.trim()),
      display: true
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 4. LaTeX Display math: \[...\]
  cleaned = cleaned.replace(/\\\[([\s\S]+?)\\\]/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: normalizeMathToLatex(math.trim()),
      display: true
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 5. LaTeX Inline math: \(...\)
  cleaned = cleaned.replace(/\\\(([\s\S]+?)\\\)/g, (match, math) => {
    mathTokens.push({
      id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
      math: normalizeMathToLatex(math.trim()),
      display: false
    });
    return mathTokens[mathTokens.length - 1].id;
  });

  // 6. Inline dollar math: $...$ with strict accounting currency guards
  // Opening $ cannot be preceded by word char or backslash and cannot be followed by a space;
  // digits ARE allowed after the opening $ so $30^\circ$-style math matches — the
  // isLikelyInlineMath currency guards decide whether it renders.
  // Closing $ cannot be preceded by space, cannot be followed by digit.
  cleaned = cleaned.replace(/(?<![\w\\])\$(?!\s)([^\$\n]+?)(?<!\s)\$(?!\d)/g, (match, math) => {
    if (isLikelyInlineMath(math)) {
      mathTokens.push({
        id: `%%%MATH_TOKEN_${mathTokens.length}%%%`,
        math: normalizeMathToLatex(math.trim()),
        display: false
      });
      return mathTokens[mathTokens.length - 1].id;
    }
    return match;
  });

  // 7. Parenthesized LaTeX expressions: ( ... ) with balanced inner parentheses
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
            math: normalizeMathToLatex(inner),
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
