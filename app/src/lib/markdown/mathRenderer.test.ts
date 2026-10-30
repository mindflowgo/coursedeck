import { describe, it, expect } from 'bun:test';
import {
  extractMathFromMarkdown,
  restoreMathTokens,
  isLikelyInlineMath,
  renderTextWithMath
} from './mathRenderer';
import { Marked } from 'marked';

describe('mathRenderer', () => {
  const marked = new Marked({ gfm: true, breaks: true });

  const renderFull = (md: string) => {
    const { processedMarkdown, mathTokens } = extractMathFromMarkdown(md);
    const html = marked.parse(processedMarkdown) as string;
    return restoreMathTokens(html, mathTokens);
  };

  it('renders all course notes math expressions correctly', () => {
    const input = `notes has:
No variables in denominators.
Rational function	(\\frac{P(x)}{Q(x)}), (Q(x)\\neq0).
Restriction	Values that make denominator zero; always state with simplified expression.
Exponent division	(\\frac{x^m}{x^n}=x^{m-n}).
Negative exponent	(x^{-n}=\\frac{1}{x^n}).`;

    const result = renderFull(input);

    // Verify all 4 expressions were transformed into KaTeX HTML
    expect(result).toContain('class="katex"');
    const katexCount = (result.match(/class="katex"/g) || []).length;
    expect(katexCount).toBe(4);

    // Verify the raw LaTeX code is properly formatted inside KaTeX annotations
    expect(result).toContain('\\frac{P(x)}{Q(x)}');
    expect(result).toContain('Q(x)\\neq0');
    expect(result).toContain('\\frac{x^m}{x^n}=x^{m-n}');
    expect(result).toContain('x^{-n}=\\frac{1}{x^n}');
  });

  it('renders LaTeX \\(...\\) and \\[...\\] notations', () => {
    const input = 'Inline: \\(\\sqrt{x^2 + 1}\\) and Display: \\[\\frac{a}{b}\\]';
    const result = renderFull(input);

    const katexCount = (result.match(/class="katex"/g) || []).length;
    expect(katexCount).toBe(2);
    expect(result).toContain('class="katex-display"');
  });

  it('renders standard dollar math $$...$$ and $...$', () => {
    const input = 'Equation $x^2 + y^2 = r^2$ and block: $$\\int_0^1 x dx$$';
    const result = renderFull(input);

    const katexCount = (result.match(/class="katex"/g) || []).length;
    expect(katexCount).toBe(2);
    expect(result).toContain('class="katex-display"');
  });

  it('STRICTLY guards accounting currency values from being treated as math', () => {
    const accountingExamples = [
      'We purchased equipment for $1500 and then $2500 of inventory.',
      "TJ's Garage charges $20 plus $40 per hour.",
      'Net income was $45,000, up from $30,000.',
      'Debit Cash $500, Credit Accounts Receivable $500.',
      'Total revenue was $1,500.50 compared to expenses of $950.25.',
      'Prices range from $ 100 to $ 200.'
    ];

    for (const example of accountingExamples) {
      const result = renderFull(example);
      // None of the accounting currency values should become KaTeX
      expect(result).not.toContain('class="katex"');
      // The currency values should be preserved literally
      if (example.includes('$1500')) {
        expect(result).toContain('$1500');
        expect(result).toContain('$2500');
      }
      if (example.includes('$20')) {
        expect(result).toContain('$20');
        expect(result).toContain('$40');
      }
      if (example.includes('$45,000')) {
        expect(result).toContain('$45,000');
        expect(result).toContain('$30,000');
      }
    }
  });

  it('does not treat code blocks or inline code containing $ or \\ as math', () => {
    const input = 'Use `const $price = 100;` or:\n```\nconst $total = $price * 2;\n```';
    const result = renderFull(input);
    expect(result).not.toContain('class="katex"');
    expect(result).toContain('const $price = 100;');
  });

  it('isLikelyInlineMath correctly identifies math vs text', () => {
    // Valid math
    expect(isLikelyInlineMath('x^2')).toBe(true);
    expect(isLikelyInlineMath('\\frac{1}{2}')).toBe(true);
    expect(isLikelyInlineMath('x_1')).toBe(true);
    expect(isLikelyInlineMath('x')).toBe(true);
    expect(isLikelyInlineMath('a + b = c')).toBe(true);

    // Accounting currency / plain prose
    expect(isLikelyInlineMath('1500 and then ')).toBe(false);
    expect(isLikelyInlineMath('20 plus 40 per hour')).toBe(false);
    expect(isLikelyInlineMath('45,000')).toBe(false);
    expect(isLikelyInlineMath('1,500')).toBe(false);
    expect(isLikelyInlineMath('cash and assets')).toBe(false);
  });

  it('accepts digit-leading content when it carries LaTeX structure', () => {
    // Trig/equation content the prompts explicitly elicit ($30^\circ$, $2^3 = 8$)
    expect(isLikelyInlineMath('30^\\circ')).toBe(true);
    expect(isLikelyInlineMath('2^3 = 8')).toBe(true);
    expect(isLikelyInlineMath('5 \\times 10^3')).toBe(true);
    // Numeric coefficient with a variable ($5x$, $2n$)
    expect(isLikelyInlineMath('5x')).toBe(true);
    expect(isLikelyInlineMath('2n')).toBe(true);
    // ...but k/m/b suffixes read as currency magnitudes ($5k, $2m, $3b)
    expect(isLikelyInlineMath('5k')).toBe(false);
    expect(isLikelyInlineMath('2m')).toBe(false);
    expect(isLikelyInlineMath('3b')).toBe(false);
  });

  it('still rejects digit-leading content without LaTeX structure as currency', () => {
    expect(isLikelyInlineMath('5,000')).toBe(false);
    expect(isLikelyInlineMath('1,500.50')).toBe(false);
    expect(isLikelyInlineMath('5000 and rising')).toBe(false);
    expect(isLikelyInlineMath('5+')).toBe(false);
  });

  it('accepts comma-separated single-letter parameter lists', () => {
    // Real case from mcr3u/04.09.summary.md: "each parameter $a, k, d, c$ controls..."
    expect(isLikelyInlineMath('a, k, d, c')).toBe(true);
    expect(isLikelyInlineMath('h, k')).toBe(true);
    // Digit groups separated by commas stay currency-shaped ($45,000)
    expect(isLikelyInlineMath('45,000')).toBe(false);
    expect(isLikelyInlineMath('5, 10, 15')).toBe(false);
  });

  it('renders digit-leading inline math and parameter lists end-to-end', () => {
    const input =
      'The angle is $30^\\circ$, the slope is $5x$, and each parameter $a, k, d, c$ controls one feature.';
    const result = renderFull(input);

    const katexCount = (result.match(/class="katex"/g) || []).length;
    expect(katexCount).toBe(3);
    expect(result).not.toContain('$a, k, d, c$');
  });

  it('does not treat markdown image and link URLs as parenthesized math', () => {
    // Real case: ./assets/img/clu3m_01.02.200.jpg contains _ and /, which the
    // parenthesized-LaTeX heuristic would otherwise swallow as math.
    const image = '![A person examining a book in a law library|25%](./assets/img/clu3m_01.02.200.jpg)';
    const imageResult = renderFull(image);
    expect(imageResult).not.toContain('class="katex"');
    expect(imageResult).toContain('<img');
    expect(imageResult).toContain('src="./assets/img/clu3m_01.02.200.jpg"');

    const link = 'See [the intro guide](https://example.com/a_b/intro) for details.';
    const linkResult = renderFull(link);
    expect(linkResult).not.toContain('class="katex"');
    expect(linkResult).toContain('href="https://example.com/a_b/intro"');
  });

  it('renders \\(...\\) math in plain quiz text via renderTextWithMath', () => {
    const html = renderTextWithMath('What is \\(\\frac{5}{7}\\) of <b>70</b>?');
    expect(html).toContain('class="katex"');
    // Non-math text is HTML-escaped so it is safe to inject
    expect(html).toContain('&lt;b&gt;70&lt;/b&gt;');
    expect(html).not.toContain('<b>70</b>');
  });

  it('renderTextWithMath renders dollar math but keeps currency literal', () => {
    const html = renderTextWithMath('Compute $x^2$ when revenue was $1,500.');
    expect(html).toContain('class="katex"');
    expect(html).toContain('$1,500');
  });

  it('renderTextWithMath escapes plain text without math', () => {
    const html = renderTextWithMath('Depreciation & amortization');
    expect(html).toBe('Depreciation &amp; amortization');
  });

  it('renderTextWithMath parses **bold** into <strong> tags without double-escaping', () => {
    const html = renderTextWithMath("Which statement best defines **owner's equity** and **$85,000**?");
    expect(html).toContain("<strong>owner&#39;s equity</strong>");
    expect(html).toContain("<strong>$85,000</strong>");
    expect(html).not.toContain("**owner");
  });

  it('renderTextWithMath handles mixed LaTeX math and markdown **bold**', () => {
    const html = renderTextWithMath("Find the **hypotenuse** when \\(c = \\sqrt{a^2 + b^2}\\).");
    expect(html).toContain('<strong>hypotenuse</strong>');
    expect(html).toContain('class="katex"');
  });
});
