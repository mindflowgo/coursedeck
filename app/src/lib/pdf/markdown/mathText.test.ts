import { describe, it, expect } from 'bun:test';
import { splitMathSegments, renderMathToText, latexToUnicode } from './mathText';

describe('mathText PDF renderer', () => {
  it('converts course cheatsheet formulas to readable unicode in PDF', () => {
    const input = 'Rational function (\\frac{P(x)}{Q(x)}), (Q(x)\\neq0). Exponent division (\\frac{x^m}{x^n}=x^{m-n}).';
    const text = renderMathToText(input);

    expect(text).toContain('(P(x)) / (Q(x))');
    expect(text).toContain('≠');
    expect(text).toContain('xᵐ⁻ⁿ');
  });

  it('converts standard LaTeX $...$ and $$...$$ to unicode in PDF', () => {
    const input = 'Equation: $x^2 + y^2 = r^2$ and display $$E = mc^2$$.';
    const text = renderMathToText(input);

    expect(text).toContain('x²+y²=r²');
    expect(text).toContain('mc²');
  });

  it('preserves accounting currency values as literal text in PDF without treating as math', () => {
    const currencyNotes = 'The company had $1500 and then $2500 in revenue, with inventory valued at $30,000.';
    const text = renderMathToText(currencyNotes);

    expect(text).toBe(currencyNotes);
    const segments = splitMathSegments(currencyNotes);
    expect(segments.every(s => s.kind === 'text')).toBe(true);
  });
});
