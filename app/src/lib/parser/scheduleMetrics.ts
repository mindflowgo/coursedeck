/**
 * Information-density analysis of a lesson summary, used by the schedule
 * generator to pace lessons: a summary packed with formulas, key terms and
 * lists signals many distinct concepts per page, which deserves more or
 * longer sessions than a narrative summary of the same length.
 */
export interface SummaryDensity {
  words: number;
  /** LaTeX commands, exponents, subscripts and inline $...$ spans. */
  mathTokens: number;
  boldTerms: number;
  listItems: number;
  headings: number;
  /** Concept signals per 100 words of summary text. */
  conceptsPer100Words: number;
  density: 'low' | 'medium' | 'high';
}

/** Word count matching the tokenizer used by computeSummaryDensity. */
export function countWords(text: string): number {
  return ((text || '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z]+)?/g) || []).length;
}

export function computeSummaryDensity(text: string): SummaryDensity {
  const clean = text || '';

  const words = (clean.match(/[A-Za-z0-9]+(?:['’-][A-Za-z]+)?/g) || []).length;
  const mathTokens =
    (clean.match(/\\[a-zA-Z]+|\^|_/g) || []).length +
    (clean.match(/\$[^$\n]+\$/g) || []).length;
  const boldTerms = (clean.match(/\*\*[^*\n]+\*\*/g) || []).length;
  const listItems = (clean.match(/^\s*(?:[-*+]|\d+\.)\s+/gm) || []).length;
  const headings = (clean.match(/^#{1,6}\s+/gm) || []).length;

  const signals = mathTokens + boldTerms + listItems + headings;
  const per100 = words > 0 ? (signals / words) * 100 : 0;

  const density: SummaryDensity['density'] = per100 >= 16 ? 'high' : per100 >= 3.5 ? 'medium' : 'low';

  return {
    words,
    mathTokens,
    boldTerms,
    listItems,
    headings,
    conceptsPer100Words: Math.round(per100 * 10) / 10,
    density
  };
}
