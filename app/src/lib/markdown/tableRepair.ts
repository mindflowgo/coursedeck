/**
 * Table normalizer and repair pipeline for Markdown.
 *
 * Background:
 * When course HTML is ingested via Turndown / GFM, multiline cell content
 * (e.g. `<br>` or `<p>` tags inside `<th>` and `<td>` elements) is frequently
 * serialized with literal raw newlines (`\n`) between table pipes.
 *
 * According to GitHub Flavored Markdown (GFM) and CommonMark specifications,
 * every table row (both the header and subsequent body rows) must exist on a
 * single continuous line. Any raw unescaped line break splits the table,
 * causing Marked to abort table parsing and fall back to plain paragraphs.
 *
 * This module reconstructs and normalizes broken multiline markdown tables:
 * 1. Collapses multiline headers into single-line rows with `<br>`.
 * 2. Collapses multiline body cells into single-line rows with `<br>`.
 * 3. Pads incomplete rows to match delimiter column counts.
 * 4. Separates stacked adjacent tables (e.g. accounting journals) with blank lines.
 * 5. Protects code blocks so code snippets are never touched.
 */

/**
 * Splits a table row into cells, respecting escaped pipes (`\|`).
 */
export function splitTableCells(row: string): string[] {
  const trimmed = row.trim();
  let s = trimmed;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      current += '\\|';
      i++;
    } else if (s[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += s[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Delimiter line regex matching GFM table separator lines like `| --- | --- |`
 * or `|:---|---:|` or `> | --- | --- |`.
 */
const DELIM_REGEX = /^\s*(?:>\s*)*\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?::?-{3,}:?\s*)?\|?\s*$/;

/**
 * Repairs multiline markdown tables into valid single-line GFM tables.
 */
export function repairMarkdownTables(markdown: string): string {
  if (!markdown || !markdown.includes('|')) return markdown;

  // Protect pre and code blocks so code snippets are never modified
  const codeBlocks: string[] = [];
  let cleaned = markdown.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    codeBlocks.push(match);
    return `%%%TABLE_CODE_${codeBlocks.length - 1}%%%`;
  });

  const lines = cleaned.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if line is a table delimiter row
    const delimMatch = line.match(/^(\s*(?:>\s*)*)(\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?::?-{3,}:?\s*)?\|?\s*)$/);
    if (delimMatch) {
      const quotePrefix = delimMatch[1] || '';
      const rawDelim = delimMatch[2].trim();
      const delimCells = rawDelim.split('|').map((c) => c.trim()).filter(Boolean);
      const colCount = delimCells.length;

      if (colCount >= 1) {
        // Collect header lines looking backwards
        const headerLines: string[] = [];
        let pipesFound = 0;
        let popCount = 0;

        for (let j = result.length - 1; j >= 0; j--) {
          const prevLine = result[j];
          if (
            prevLine.includes('%%%TABLE_CODE_') ||
            DELIM_REGEX.test(prevLine) ||
            /^\s*#{1,6}\s/.test(prevLine) ||
            /^\s*---\s*$/.test(prevLine)
          ) {
            break;
          }

          const stripped = prevLine.replace(/^\s*(?:>\s*)+/, '');
          const pipeCount = (stripped.match(/\|/g) || []).length;

          // If blank line and no pipes collected yet, stop
          if (stripped.trim() === '' && pipesFound === 0) {
            break;
          }

          headerLines.unshift(prevLine);
          pipesFound += pipeCount;
          popCount++;

          if (pipesFound >= colCount + 1) {
            break;
          }
        }

        if (pipesFound >= colCount) {
          result.splice(result.length - popCount, popCount);

          // If previous line in result was part of another table row, separate with blank line
          if (
            result.length > 0 &&
            result[result.length - 1].trim().endsWith('|') &&
            !result[result.length - 1].includes('%%%TABLE_CODE_')
          ) {
            result.push('');
          }

          const rawHeader = headerLines.map((l) => l.replace(/^\s*(?:>\s*)+/, '').trim()).join('\n');
          const rawCells = splitTableCells(rawHeader);
          if (rawCells.length >= colCount) {
            const cleanCells = rawCells.slice(0, colCount).map((c) =>
              c.replace(/\n+/g, '<br>').replace(/\s+/g, ' ').trim()
            );
            while (cleanCells.length < colCount) cleanCells.push('');
            result.push(quotePrefix + '| ' + cleanCells.join(' | ') + ' |');
          } else {
            result.push(...headerLines);
          }
        }

        // Push normalized delimiter row
        const cleanDelims = delimCells.map((c) => {
          const left = c.startsWith(':');
          const right = c.endsWith(':');
          if (left && right) return ':-:';
          if (left) return ':--';
          if (right) return '--:';
          return '---';
        });
        result.push(quotePrefix + '| ' + cleanDelims.join(' | ') + ' |');

        // Process subsequent body rows
        i++;
        let inTableBody = true;
        while (i < lines.length && inTableBody) {
          const bodyLine = lines[i];
          const stripped = bodyLine.replace(/^\s*(?:>\s*)+/, '').trim();

          // Stop conditions
          if (
            DELIM_REGEX.test(bodyLine) ||
            bodyLine.includes('%%%TABLE_CODE_') ||
            /^\s*#{1,6}\s/.test(bodyLine) ||
            /^\s*---\s*$/.test(bodyLine)
          ) {
            inTableBody = false;
            break;
          }

          // Check for upcoming delimiter row within 1-5 lines (means a new stacked table is ahead)
          let upcomingDelim = false;
          for (let look = i + 1; look < Math.min(lines.length, i + 6); look++) {
            if (DELIM_REGEX.test(lines[look])) {
              upcomingDelim = true;
              break;
            }
            if (lines[look].includes('%%%TABLE_CODE_') || /^\s*#{1,6}\s/.test(lines[look])) break;
          }

          if (stripped === '') {
            // Check if next non-empty line has pipes
            let nextHasPipe = false;
            for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
              const peek = lines[k].replace(/^\s*(?:>\s*)+/, '').trim();
              if (peek === '') continue;
              if (peek.includes('|')) nextHasPipe = true;
              break;
            }
            if (!nextHasPipe) {
              inTableBody = false;
              break;
            }
          }

          // If upcoming delimiter line exists and this line looks like the header for that table:
          if (upcomingDelim && stripped.includes('|')) {
            const peekCells = splitTableCells(stripped);
            if (peekCells.length !== colCount) {
              inTableBody = false;
              result.push('');
              break;
            }
          }

          // Collect body row lines
          let rowLines = [bodyLine];
          let rowPipes = (stripped.match(/\|/g) || []).length;
          let k = i + 1;

          // A row is considered self-contained and closed on its single line if:
          // 1. It starts with '|' and ends with '|' (and not an escaped pipe)
          // 2. It has at least 2 pipes (an opening and closing pipe)
          // 3. It has some non-whitespace content between pipes (not just bare delimiters)
          const isRowClosed =
            rowPipes >= 2 &&
            stripped.length > 1 &&
            stripped.startsWith('|') &&
            stripped.endsWith('|') &&
            !stripped.endsWith('\\|') &&
            stripped.replace(/\|/g, '').trim().length > 0;

          while (k < lines.length && rowPipes < colCount + 1) {
            const nextLine = lines[k];
            const nextStripped = nextLine.replace(/^\s*(?:>\s*)+/, '').trim();
            if (
              DELIM_REGEX.test(nextLine) ||
              nextLine.includes('%%%TABLE_CODE_') ||
              /^\s*#{1,6}\s/.test(nextLine) ||
              /^\s*---\s*$/.test(nextLine)
            ) {
              break;
            }

            const nextPipes = (nextStripped.match(/\|/g) || []).length;
            const isNextBarePipe = nextStripped.replace(/\|/g, '').trim().length === 0;

            // If the current row is already closed on its line and next line starts with '|',
            // or if the next line is itself a fully formed row (at least colCount + 1 pipes),
            // then next line is a new row, not a continuation.
            if (
              !isNextBarePipe &&
              nextStripped.startsWith('|') &&
              (isRowClosed || nextPipes >= colCount + 1)
            ) {
              break;
            }

            rowLines.push(nextLine);
            rowPipes += nextPipes;
            k++;
          }

          if (rowPipes >= 1) {
            const rawRow = rowLines.map((l) => l.replace(/^\s*(?:>\s*)+/, '').trim()).join('\n');
            const rawCells = splitTableCells(rawRow);
            if (rawCells.length >= 1) {
              const cleanCells = rawCells.slice(0, colCount).map((c) =>
                c.replace(/\n+/g, '<br>').replace(/\s+/g, ' ').trim()
              );
              while (cleanCells.length < colCount) cleanCells.push('');
              result.push(quotePrefix + '| ' + cleanCells.join(' | ') + ' |');
              i = k;
              continue;
            }
          }

          result.push(bodyLine);
          i++;
        }
        continue;
      }
    }

    result.push(line);
    i++;
  }

  let finalMd = result.join('\n');
  // Restore code blocks
  finalMd = finalMd.replace(/%%%TABLE_CODE_(\d+)%%%/g, (_, idx) => codeBlocks[Number(idx)] || '');
  return finalMd;
}
