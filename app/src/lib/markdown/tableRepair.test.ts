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

  test('preserves empty columns including || and pads short rows without swallowing lines', () => {
    const input = `| Date | Account Title | P.R. | Debit | Credit |
| --- | --- | --- | --- | --- |
| Feb 1 | Cash | | $1,500 ||
| Feb 2 ||| $200 | $200 |
| Feb 3 | Accounts Payable | 101 | $500 |
| Feb 4 | Equipment |
| Feb 5 | Supplies | 102 | $300 | $300 |`;

    const repaired = repairMarkdownTables(input);
    const html = renderFullHtml(input);

    expect(html).toContain('<table>');
    // Ensure all 5 rows exist in output
    expect(html).toContain('<td>Feb 1</td>');
    expect(html).toContain('<td>Feb 2</td>');
    expect(html).toContain('<td>Feb 3</td>');
    expect(html).toContain('<td>Feb 4</td>');
    expect(html).toContain('<td>Feb 5</td>');

    // Check cells count in each row of repaired output
    const lines = repaired.trim().split('\n');
    for (let j = 2; j < lines.length; j++) {
      const cells = splitTableCells(lines[j]);
      expect(cells.length).toBe(5);
    }
  });

  test('repairs multiline tables where cells and pipe delimiters are separated by raw newlines (GWL3O 01.05)', () => {
    const input = `| 
Slide

 | 

Topic

 | 

Information to Include

 | 

Points and visuals you will include

 |
| --- | --- | --- | --- |
| 

1

 | 

Introduction

 | 

Name, age, and any other information you would like to include about yourself.

 |  |
| 

2

 | 

Characteristics

 | 

How would someone else describe me? (Are you funny, loving, athletic, creative?) Provide at least three characteristics.

 |  |
| 

3

 | 

Values

Hope, service, responsibility, faith, honour, trust, freedom, honesty, integrity, justice, truth and family

 | 

What are the top three things that are important to me?

 |  |`;

    const repaired = repairMarkdownTables(input);
    const html = renderFullHtml(input);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Slide</th>');
    expect(html).toContain('<th>Topic</th>');
    expect(html).toContain('<th>Information to Include</th>');
    expect(html).toContain('<th>Points and visuals you will include</th>');

    // Row 1
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<td>Introduction</td>');
    expect(html).toContain('<td>Name, age, and any other information you would like to include about yourself.</td>');

    // Row 2
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<td>Characteristics</td>');

    // Row 3 (multiline text in single cell collapsed with <br>)
    expect(html).toContain('<td>Values<br>Hope, service, responsibility, faith, honour, trust, freedom, honesty, integrity, justice, truth and family</td>');

    const lines = repaired.trim().split('\n');
    // Header (line 0) + delimiter (line 1) + 3 body rows = 5 lines total
    expect(lines.length).toBe(5);
    for (let j = 0; j < lines.length; j++) {
      if (j === 1) continue; // delimiter
      const cells = splitTableCells(lines[j]);
      expect(cells.length).toBe(4);
    }
  });
});
