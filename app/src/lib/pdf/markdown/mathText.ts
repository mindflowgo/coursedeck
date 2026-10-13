/**
 * LaTeX → Unicode plain-text renderer.
 *
 * The PDF pipeline draws real vector text (no canvas rasterization), so math
 * is translated to a readable linear Unicode form (e.g. \frac{-b \pm \sqrt{b^2-4ac}}{2a}
 * → "(−b ± √(b² − 4ac)) / 2a") using the DejaVu font's wide glyph coverage.
 */

import { extractMathFromMarkdown } from '../../markdown/mathRenderer';

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
  o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ'
};

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
};

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};

const SYMBOLS: Record<string, string> = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', cdots: '⋯', ldots: '…', dots: '…',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡', approx: '≈', sim: '∼',
  propto: '∝', infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', in: '∈',
  notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  to: '→', rightarrow: '→', longrightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  circ: '∘', bullet: '•', degree: '°', prime: '′', angle: '∠', perp: '⊥', parallel: '∥',
  therefore: '∴', because: '∵', surd: '√', plusmn: '±', percent: '%%', '%': '%',
  '{': '{', '}': '}', '\\': '\\', '|': '|', ';': ' ', ':': ' ', ',': ' ', '!': '',
  quad: '  ', qquad: '    ', '$': '$', '&': '&', '#': '#', '_': '_'
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'gcd', 'lcm',
  'min', 'max', 'sup', 'inf', 'lim', 'arg', 'deg', 'mod'
]);

function toScript(chars: string, table: Record<string, string>, wrapOpen: string, wrapClose: string): string {
  let out = '';
  for (const ch of chars) {
    const mapped = table[ch];
    if (mapped === undefined) return wrapOpen + chars + wrapClose;
    out += mapped;
  }
  return out;
}

/**
 * Decides whether text between $ delimiters is really LaTeX math.
 * Currency-heavy course notes ($1,000 and $2,500) must stay literal.
 */
export function looksLikeLatex(inner: string): boolean {
  return /[\\^_]|\\frac|\\sqrt/.test(inner) && !/^\s*[\d,]/.test(inner.replace(/^\\/, ''));
}

interface RenderState {
  pos: number;
}

function readGroup(src: string, state: RenderState): string {
  skipSpaces(src, state);
  if (src[state.pos] === '{') {
    let depth = 0;
    const start = ++state.pos;
    while (state.pos < src.length) {
      const ch = src[state.pos];
      if (ch === '\\') {
        state.pos += 2;
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        if (depth === 0) break;
        depth--;
      }
      state.pos++;
    }
    const body = src.slice(start, state.pos);
    state.pos++; // consume '}'
    return body;
  }
  if (src[state.pos] === '\\') {
    const start = state.pos;
    state.pos++;
    let cmd = '';
    while (state.pos < src.length && /[a-zA-Z]/.test(src[state.pos])) {
      cmd += src[state.pos++];
    }
    if (!cmd) state.pos++;
    return src.slice(start, state.pos);
  }
  return src[state.pos++] ?? '';
}

function skipSpaces(src: string, state: RenderState): void {
  while (state.pos < src.length && src[state.pos] === ' ') state.pos++;
}

/** Renders a LaTeX fragment to linear Unicode text. */
export function latexToUnicode(input: string): string {
  const src = input;
  const state: RenderState = { pos: 0 };
  let out = '';
  let lastScriptTarget = '';

  const renderGroup = (body: string): string => latexToUnicode(body);

  while (state.pos < src.length) {
    const ch = src[state.pos];

    if (ch === '\\') {
      state.pos++;
      let cmd = '';
      while (state.pos < src.length && /[a-zA-Z]/.test(src[state.pos])) {
        cmd += src[state.pos++];
      }

      if (cmd === '') {
        // \\, \{, \} etc.
        const sym = src[state.pos++];
        out += SYMBOLS[sym] ?? sym ?? '';
        continue;
      }

      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
        const a = readGroup(src, state);
        const b = readGroup(src, state);
        const num = renderGroup(a);
        const den = renderGroup(b);
        const simple = (s: string) => s.length <= 2 && !/[\/\s]/.test(s);
        out += simple(num) && simple(den) ? `${num}/${den}` : `(${num}) / (${den})`;
        lastScriptTarget = out.slice(-1);
        continue;
      }

      if (cmd === 'sqrt') {
        skipSpaces(src, state);
        if (src[state.pos] === '[') {
          const close = src.indexOf(']', state.pos);
          const index = src.slice(state.pos + 1, close);
          state.pos = close + 1;
          out += toScript(renderGroup(index), SUPERSCRIPTS, '^( ', ')') + '√';
        } else {
          out += '√';
        }
        const body = renderGroup(readGroup(src, state));
        out += /[()+\/ ]/.test(body) ? `(${body})` : body;
        lastScriptTarget = out.slice(-1);
        continue;
      }

      if (cmd === 'text' || cmd === 'mathrm' || cmd === 'textbf' || cmd === 'mathit' || cmd === 'textrm' || cmd === 'textit') {
        out += readGroup(src, state);
        continue;
      }

      if (cmd === 'overline' || cmd === 'bar') {
        out += renderGroup(readGroup(src, state)) + '\u0304';
        continue;
      }
      if (cmd === 'underline') {
        out += renderGroup(readGroup(src, state)) + '\u0332';
        continue;
      }
      if (cmd === 'hat') {
        out += renderGroup(readGroup(src, state)) + '\u0302';
        continue;
      }

      if (cmd === 'left' || cmd === 'right' || cmd === 'displaystyle' || cmd === 'limits' || cmd === 'nolimits') {
        skipSpaces(src, state);
        continue;
      }

      if (FUNCTIONS.has(cmd)) {
        out += ` ${cmd}`;
        skipSpaces(src, state);
        continue;
      }

      if (cmd === 'begin' || cmd === 'end') {
        readGroup(src, state);
        continue;
      }

      const greek = GREEK[cmd];
      if (greek) {
        out += greek;
        lastScriptTarget = greek;
        continue;
      }

      const sym = SYMBOLS[cmd];
      if (sym !== undefined) {
        out += sym;
        continue;
      }

      // Unknown command: keep it visible but harmless.
      out += cmd;
      continue;
    }

    if (ch === '^' || ch === '_') {
      state.pos++;
      const arg = readGroup(src, state);
      const rendered = renderGroup(arg);
      out += ch === '^'
        ? toScript(rendered, SUPERSCRIPTS, '^(', ')')
        : toScript(rendered, SUBSCRIPTS, '_(', ')');
      continue;
    }

    if (ch === '{' || ch === '}') {
      state.pos++;
      continue;
    }

    if (ch === '&' || ch === '$') {
      state.pos++;
      continue;
    }

    // Soft math spacing: collapse runs of spaces around operators.
    if (ch === ' ') {
      state.pos++;
      const next = src[state.pos];
      const prev = out.slice(-1);
      if (next && /[=+\-<>\/]/.test(next)) continue;
      if (prev && /[=+\-<>\/±×÷]/.test(prev)) continue;
      out += ' ';
      continue;
    }

    out += ch;
    state.pos++;
    lastScriptTarget = ch;
  }

  // Tidy spacing produced during translation.
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;)\]])/g, '$1').trim();
}

/**
 * Splits plain text into literal and math segments ($...$ / $$...$$),
 * applying conservative currency detection to inline math.
 */
export type TextSegment = { kind: 'text' | 'math'; value: string; display?: boolean };

export function splitMathSegments(input: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const { processedMarkdown, mathTokens } = extractMathFromMarkdown(input);
  if (!mathTokens.length) {
    return [{ kind: 'text', value: input }];
  }

  const parts = processedMarkdown.split(/(%%%MATH_TOKEN_\d+%%%)/g);
  for (const part of parts) {
    if (!part) continue;
    const tokenMatch = part.match(/^%%%MATH_TOKEN_(\d+)%%%$/);
    if (tokenMatch) {
      const idx = Number(tokenMatch[1]);
      const token = mathTokens[idx];
      if (token) {
        segments.push({ kind: 'math', value: token.math, display: token.display });
        continue;
      }
    }
    segments.push({ kind: 'text', value: part });
  }

  return segments;
}

/**
 * Converts all math inside a plain string to Unicode text.
 * Used for quiz prompts/options/explanations which have no inline formatting.
 */
export function renderMathToText(input: string): string {
  return splitMathSegments(input)
    .map((seg) => (seg.kind === 'math' ? latexToUnicode(seg.value) : seg.value))
    .join('');
}
