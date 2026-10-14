import { describe, expect, test } from 'bun:test';
import { Marked } from 'marked';
import { repairMarkdownTables, splitTableCells } from './tableRepair';
import { extractMathFromMarkdown, restoreMathTokens } from './mathRenderer';

const markedParser = new Marked({ gfm: true, breaks: true });

function renderFullHtml(markdown: string): string {
  const repaired = repairMarkdownTables(markdown);
  const { processedMarkdown, mathTokens } = extractMathFromMarkdown(repaired);
  const html = markedParser.parse(processedMarkdown) as string;
  return restoreMathTokens(html, mathTokens);
}

describe('tableRepair', () => {
  test('splitTableCells handles escaped pipes and trims properly', () => {
    const row = '| Cell 1 | Cell 2 with \\| escaped pipe | Cell 3 |';
    const cells = splitTableCells(row);
    expect(cells).toEqual(['Cell 1', 'Cell 2 with \\| escaped pipe', 'Cell 3']);
  });

  test('repairs the exact BAF3M 01.06 rubric snippet from user request', () => {
    const snippet = `| Level 4
(80 – 100%) | Level 3
(70 - 79%) | Level 2
(60 – 69%) | Level 1

(50 – 59%) |
| --- | --- | --- | --- |
| Student demonstrates thorough understanding of the education and designation/`;

    const repaired = repairMarkdownTables(snippet);
    const html = renderFullHtml(snippet);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Level 4<br>(80 – 100%)</th>');
    expect(html).toContain('<th>Level 3<br>(70 - 79%)</th>');
    expect(html).toContain('<th>Level 2<br>(60 – 69%)</th>');
    expect(html).toContain('<th>Level 1<br>(50 – 59%)</th>');
    expect(html).toContain('<td>Student demonstrates thorough understanding of the education and designation/</td>');
    expect(html).toContain('</table>');
  });

  test('repairs full BAF3M 01.06 rubric with multiline header and multiline body cells', () => {
    const rubric = `| Level 4  
(80 – 100%) | Level 3  
(70 - 79%) | Level 2  
(60 – 69%) | Level 1  
(50 – 59%) |
| --- | --- | --- | --- |
| Student demonstrates thorough understanding of the education and designation/  
certification required in accounting and types of business ownership | Student demonstrates considerable understanding of the education and designation/  
certification required in accounting and types of business ownership | Student demonstrates some understanding of the education and designation/  
certification required in accounting and types of business ownership | Student demonstrates limited understanding of the education and designation/  
certification required in accounting and types of business ownership |`;

    const html = renderFullHtml(rubric);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Level 4<br>(80 – 100%)</th>');
    expect(html).toContain('<td>Student demonstrates thorough understanding of the education and designation/<br>certification required in accounting and types of business ownership</td>');
    expect(html).toContain('<td>Student demonstrates limited understanding of the education and designation/<br>certification required in accounting and types of business ownership</td>');
    expect(html).toContain('</table>');
  });

  test('preserves KaTeX math formulas inside repaired tables', () => {
    const tableWithMath = `| Concept  
Name | Math  
Formula | Notes |
| --- | --- | --- |
| Root | $\\sqrt{x^2 + y^2}$ | Euclidean |
| Fraction | $\\frac{a}{b}$ | $(b \\neq 0)$ |`;

    const html = renderFullHtml(tableWithMath);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Concept<br>Name</th>');
    expect(html).toContain('<th>Math<br>Formula</th>');
    expect(html).toContain('class="katex"');
    expect(html).toContain('Euclidean');
    expect(html).toContain('</table>');
  });

  test('strictly preserves accounting currency values inside tables', () => {
    const currencyTable = `| Account  
Title | Debit  
Amount | Credit  
Amount |
| --- | --- | --- |
| Cash | $1,500 |  |
| Accounts Payable |  | $45,000 |`;

    const html = renderFullHtml(currencyTable);
    expect(html).toContain('<table>');
    expect(html).toContain('$1,500');
    expect(html).toContain('$45,000');
    // Currency must NOT be converted to KaTeX
    expect(html).not.toContain('<annotation encoding="application/x-tex">$1,500</annotation>');
  });

  test('separates stacked adjacent tables (accounting general journal pattern)', () => {
    const stacked = `| General Journal | Page 3 |
| --- | --- |
| Date  
20-- | Accounts and Explanation | P.R. | Debit | Credit |
| --- | --- | --- | --- | --- |
| Feb. | 7 | Cash |  | 900 |  |`;

    const html = renderFullHtml(stacked);
    const tableCount = (html.match(/<table/g) || []).length;
    expect(tableCount).toBe(2);
    expect(html).toContain('<th>General Journal</th>');
    expect(html).toContain('<th>Date<br>20--</th>');
    expect(html).toContain('<td>Cash</td>');
  });

  test('does not touch markdown code blocks containing pipes or table syntax', () => {
    const codeSnippet = '```markdown\n| Not | A | Real | Table |\n| --- | --- | --- | --- |\n```';
    const repaired = repairMarkdownTables(codeSnippet);
    expect(repaired).toBe(codeSnippet);
  });

  test('supports blockquoted tables', () => {
    const quotedTable = `> | Criterion | Weight |
> | --- | --- |
> | Accuracy | 50% |
> | Clarity | 50% |`;

    const html = renderFullHtml(quotedTable);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Criterion</th>');
    expect(html).toContain('<td>Accuracy</td>');
  });
});
