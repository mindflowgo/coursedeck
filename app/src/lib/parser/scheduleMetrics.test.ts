import { describe, it, expect } from 'bun:test';
import { computeSummaryDensity } from './scheduleMetrics';

describe('computeSummaryDensity', () => {
  it('scores a prose-heavy summary as low density', () => {
    const prose = `
In this lesson we explore the historical development of trade policy in Canada.
The reading discusses how agreements evolved over the decades and what that
means for consumers today. There are no formulas here, just narrative context
and a couple of examples about supply chains and tariffs that are described
in plain language across several paragraphs of continuous discussion.
`.repeat(3);
    const d = computeSummaryDensity(prose);
    expect(d.words).toBeGreaterThan(80);
    expect(d.density).toBe('low');
  });

  it('scores a formula- and list-heavy summary as high density', () => {
    const dense = `
## Key Formulas
- $f(x) = a(x-h)^2 + k$ — vertex form
- $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$ — quadratic formula
- $\\Delta = b^2 - 4ac$ — discriminant cases
- $y = a\\sqrt{x-h} + k$ — radical transformations
- $x^2 + y^2 = r^2$ — circle relation
- $|a| > 1$ stretches; $0 < |a| < 1$ compresses
- $h$ shifts horizontally, $k$ shifts vertically
- $x^{-n} = \\frac{1}{x^n}$ — negative exponents

**Vertex**, **discriminant**, **axis of symmetry**, **domain**, **range**,
**extraneous root**, **inverse function** are the exam-critical terms.
`;
    const d = computeSummaryDensity(dense);
    expect(d.mathTokens).toBeGreaterThanOrEqual(8);
    expect(d.listItems).toBeGreaterThanOrEqual(8);
    expect(d.boldTerms).toBeGreaterThanOrEqual(5);
    expect(d.density).toBe('high');
  });

  it('scores a moderate bulleted summary as medium density', () => {
    const medium = `
An overview of the lesson with some narrative framing before the list.

- First key idea about demand curves and what shifts them
- Second key idea about elasticity of demand
- Third key idea about market equilibrium and surplus

**Demand**, **elasticity**, and **equilibrium** are the terms to remember.
There is also a short worked example about price changes to review.
`;
    const d = computeSummaryDensity(medium);
    expect(d.density).toBe('medium');
  });

  it('handles empty and garbage text without throwing', () => {
    expect(() => computeSummaryDensity('')).not.toThrow();
    expect(computeSummaryDensity('').density).toBe('low');
    expect(() => computeSummaryDensity('### \n**\n- \n$')).not.toThrow();
  });
});
