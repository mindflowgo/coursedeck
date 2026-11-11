/// Generic post-processing for PDF page text (both native extraction and OCR output).
///
/// Four conservative stages, in order:
///   1. Unicode artifact removal  — soft hyphens, zero-width chars dropped;
///      fancy/non-breaking spaces normalised to a plain ASCII space.
///   2. Horizontal whitespace collapse per line  — tabs and runs of spaces
///      collapsed to a single space; leading/trailing whitespace trimmed;
///      pure-symbol noise lines (≤ 3 chars, no alphabetic char) dropped.
///   3. Punctuation spacing fix  — removes a stray space that sits immediately
///      before `,`, `;`, or `:` within a line.
///   4. De-hyphenation  — rejoins words broken by a line-end hyphen
///      (`word-\ncontinuation` → `wordcontinuation`).
///   5. Blank-line normalisation  — collapses runs of 3+ consecutive blank
///      lines into at most 2 blank lines.
///
/// Intentionally *not* done: reflowing prose, correcting OCR character errors,
/// or any document-specific heuristics.
pub fn clean_page_text(raw: &str) -> String {
    // ── Stage 1: Unicode artifact removal ────────────────────────────────────
    let s: String = raw
        .chars()
        .filter_map(|c| match c {
            // Drop invisible / zero-width artifacts
            '\u{00AD}' // soft hyphen
            | '\u{200B}' // zero-width space
            | '\u{200C}' // zero-width non-joiner
            | '\u{200D}' // zero-width joiner
            | '\u{FEFF}' // BOM / zero-width no-break space
            => None,
            // Normalise fancy spaces to a regular ASCII space
            '\u{00A0}' // non-breaking space
            | '\u{202F}' // narrow non-breaking space
            | '\u{2009}' // thin space
            | '\u{2002}' // en space
            | '\u{2003}' // em space
            => Some(' '),
            c => Some(c),
        })
        .collect();

    // ── Stage 2: Per-line horizontal whitespace collapse + noise filter ───────
    let mut out_lines: Vec<String> = Vec::new();
    for raw_line in s.lines() {
        let collapsed = collapse_horizontal_ws(raw_line);

        // Drop lines that carry zero alphabetic chars and are very short.
        // These are almost always stray punctuation artifacts (e.g. `'`, `,`,
        // `*>`) from scan borders or OCR misreads of printer marks.
        let has_alpha = collapsed.chars().any(|c| c.is_alphabetic());
        if !has_alpha && collapsed.len() <= 3 {
            continue;
        }

        // ── Stage 3: Punctuation spacing (within this line only) ─────────────
        let fixed = fix_punct_spacing(&collapsed);
        out_lines.push(fixed);
    }

    let s2 = out_lines.join("\n");

    // ── Stage 4: De-hyphenation ───────────────────────────────────────────────
    let s3 = dehyphenate(&s2);

    // ── Stage 5: Blank-line normalisation ────────────────────────────────────
    normalize_blank_lines(&s3)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Collapse runs of horizontal whitespace (spaces and tabs) within a single
/// line into one ASCII space. Trims the result.
fn collapse_horizontal_ws(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    // `in_space` starts true so that any leading whitespace is eaten.
    let mut in_space = true;
    for c in line.chars() {
        if c == ' ' || c == '\t' {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(c);
            in_space = false;
        }
    }
    // Remove a trailing space that may have been appended.
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Remove a single space that sits directly before `,`, `;`, or `:`.
///
/// Works character-by-character within one line and never crosses newlines,
/// so list separators, numbered items, and multi-line constructs are safe.
fn fix_punct_spacing(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    while i < n {
        let c = chars[i];
        // If the current char is a space and the next is `,` `;` or `:`
        // drop the space — the punctuation will be written in the next pass.
        if c == ' ' && i + 1 < n && matches!(chars[i + 1], ',' | ';' | ':') {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Rejoin words hyphenated at a line break.
///
/// Matches: a line whose last two characters are `[A-Za-z]-`, where the very
/// next non-empty line starts with a lowercase letter. The trailing hyphen and
/// the newline between the lines are both removed.
///
/// Intentional mid-word hyphens (e.g. `state-of-the-art`) are untouched
/// because the hyphen is not at the end of a line.
///
/// A trailing hyphen before an uppercase continuation (e.g. a chapter heading)
/// is also left intact, since uppercase indicates a new structural element.
///
/// The pass repeats until stable so that joining one pair doesn't hide a
/// hyphen that was carried inside the consumed "next" line (e.g. chain splits
/// like `recur-\nring wants and tech-\nnical`).
fn dehyphenate(text: &str) -> String {
    let mut current = text.to_string();
    loop {
        let next = dehyphenate_pass(&current);
        if next == current {
            break;
        }
        current = next;
    }
    current
}

/// Single pass of de-hyphenation over the lines of `text`.
fn dehyphenate_pass(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        // Check for trailing hyphen with alphabetic char before it.
        if i + 1 < lines.len() && line.ends_with('-') {
            let before_hyphen = line[..line.len() - 1]
                .chars()
                .next_back()
                .map_or(false, |c| c.is_alphabetic());

            // The continuation must start with a lowercase letter (uppercase
            // signals a heading or proper noun beginning a new element).
            let next = lines[i + 1].trim_start();
            let next_starts_lower = next.chars().next().map_or(false, |c| c.is_lowercase());

            if before_hyphen && next_starts_lower {
                // Strip the hyphen and join with the continuation word.
                out.push(format!("{}{}", &line[..line.len() - 1], next));
                i += 2; // next line has been consumed
                continue;
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

/// Collapse runs of 3 or more consecutive blank lines into exactly 2 blank
/// lines, then trim the result.
fn normalize_blank_lines(text: &str) -> String {
    let mut out_lines: Vec<&str> = Vec::new();
    let mut consecutive_blank: usize = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            consecutive_blank += 1;
            if consecutive_blank <= 2 {
                out_lines.push("");
            }
            // excess blank lines are silently dropped
        } else {
            consecutive_blank = 0;
            out_lines.push(line);
        }
    }
    out_lines.join("\n").trim().to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tab_collapse_between_words() {
        let input = "This \ttreatise \tis \ta \trevision";
        assert_eq!(clean_page_text(input), "This treatise is a revision");
    }

    #[test]
    fn test_tab_collapse_preserves_newlines() {
        let input = "First \tline\nSecond \tline";
        let result = clean_page_text(input);
        assert!(result.contains("First line"));
        assert!(result.contains("Second line"));
    }

    #[test]
    fn test_dehyphenation_basic() {
        let input = "Practical Gram-\nmar, first published";
        assert_eq!(clean_page_text(input), "Practical Grammar, first published");
    }

    #[test]
    fn test_dehyphenation_chain() {
        // Two consecutive line-break hyphens in the same block of text.
        let input = "the ever-recur-\nring wants and tech-\nnical terms";
        let result = clean_page_text(input);
        assert!(result.contains("ever-recurring"));
        assert!(result.contains("technical terms"));
    }

    #[test]
    fn test_intentional_hyphen_preserved() {
        // Mid-word / compound hyphens (not at end of line) must not be changed.
        let input = "state-of-the-art class-room design";
        assert_eq!(clean_page_text(input), "state-of-the-art class-room design");
    }

    #[test]
    fn test_uppercase_continuation_not_joined() {
        // Next line starts with uppercase → not a soft line-break; keep hyphen.
        let input = "Chapter-\nSECTION ONE";
        let result = clean_page_text(input);
        assert!(result.contains("Chapter-"));
    }

    #[test]
    fn test_punct_spacing_colon() {
        let input = "four parts :";
        assert_eq!(clean_page_text(input), "four parts:");
    }

    #[test]
    fn test_punct_spacing_comma_and_semicolon() {
        let input = "Orthography , Etymology ; Syntax";
        let result = clean_page_text(input);
        assert!(result.contains("Orthography, Etymology; Syntax"));
    }

    #[test]
    fn test_noise_filter_drops_lone_punctuation() {
        let input = "Good text\n'\n,\n*\nMore text";
        let result = clean_page_text(input);
        assert!(result.contains("Good text"));
        assert!(result.contains("More text"));
        // Lone `'`, `,`, `*` should be gone
        assert!(!result.contains("\n'\n"));
        assert!(!result.contains("\n,\n"));
    }

    #[test]
    fn test_noise_filter_keeps_short_alpha_lines() {
        // Single uppercase letter (e.g. list marker) should NOT be dropped.
        let input = "Header\nA\nContent";
        let result = clean_page_text(input);
        assert!(result.contains('A'));
    }

    #[test]
    fn test_blank_line_normalisation() {
        let input = "Para one\n\n\n\n\nPara two";
        let result = clean_page_text(input);
        assert!(!result.contains("\n\n\n"));
        assert!(result.contains("Para one"));
        assert!(result.contains("Para two"));
    }

    #[test]
    fn test_soft_hyphen_removed() {
        let input = "word\u{00AD}break";
        assert_eq!(clean_page_text(input), "wordbreak");
    }

    #[test]
    fn test_nbsp_normalised_to_space() {
        let input = "word\u{00A0}word";
        assert_eq!(clean_page_text(input), "word word");
    }

    #[test]
    fn test_full_page_sample() {
        // Approximation of the Harvey's Grammar page 5 preface sample.
        let input = "PREFACE\nThis \ttreatise \tis \ta \trevision \tof \tthe \tauthor's \tPractical \tGram-\nmar, \tfirst \tpublished \tten \tyears \tago.\n'\n,\n\n\n\nAccuracy \tand \tfacility \tin \tthe \tuse \tof \tlanguage, \tboth \tspoken\nand \twritten, \tare \tthe \tchief \tends \tto \tbe \tsecured \tby \tthe \tstudy\nof \tgrammar.";
        let result = clean_page_text(input);
        // Tabs collapsed
        assert!(!result.contains('\t'));
        // De-hyphenation: Gram- + mar → Grammar
        assert!(result.contains("Practical Grammar"));
        // Noise lines dropped
        assert!(!result.contains("\n'\n"));
        // Excessive blank lines collapsed
        assert!(!result.contains("\n\n\n"));
    }
}
