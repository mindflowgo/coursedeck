/**
 * Dark-mode conversion for inline styles that arrive from ingested course HTML.
 *
 * Heading-less course tables are kept as raw HTML by the GFM turndown plugin,
 * so their `style="background-color: #eceff0"` survives all the way into the
 * reader. In dark mode the prose wrapper inverts text to a light colour but
 * cannot touch an inline background, leaving light text on a light cell that
 * reads as empty. These helpers map light inline backgrounds to dark
 * equivalents (and dark inline text colours to light ones) at render time.
 *
 * Light mode is never touched, and the colour math is DOM-free so it can be
 * unit-tested under `bun test`.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** Alpha 0..1; absent/1 means fully opaque. */
  a?: number;
}

/** Colours above this WCAG relative luminance are "light" and get darkened. */
const LIGHT_THRESHOLD = 0.5;

/** Inline text colours below this luminance are "dark" and get lightened. */
const DARK_TEXT_THRESHOLD = 0.4;

const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  snow: '#fffafa',
  ivory: '#fffff0',
  lightyellow: '#ffffe0',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  silver: '#c0c0c0',
  gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5',
  beige: '#f5f5dc',
  linen: '#faf0e6',
  seashell: '#fff5ee',
  oldlace: '#fdf5e6',
  floralwhite: '#fffaf0',
  azure: '#f0ffff',
  aliceblue: '#f0f8ff',
  ghostwhite: '#f8f8ff',
  lavender: '#e6e6fa',
  thistle: '#d8bfd8',
  pink: '#ffc0cb',
  lightpink: '#ffb6c1',
  hotpink: '#ff69b4',
  lightblue: '#add8e6',
  lightcyan: '#e0ffff',
  palegreen: '#98fb98',
  lightgreen: '#90ee90',
  khaki: '#f0e68c',
  wheat: '#f5deb3',
  gold: '#ffd700',
  yellow: '#ffff00',
  orange: '#ffa500',
  coral: '#ff7f50',
  salmon: '#fa8072',
  lightsalmon: '#ffa07a',
  tomato: '#ff6347',
  black: '#000000',
  dimgray: '#696969',
  dimgrey: '#696969',
  gray: '#808080',
  grey: '#808080',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  red: '#ff0000',
  darkred: '#8b0000',
  maroon: '#800000',
  green: '#008000',
  darkgreen: '#006400',
  blue: '#0000ff',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  olive: '#808000',
  brown: '#a52a2a'
};

/** Values that must never be interpreted (or rewritten) as a colour. */
const NON_COLORS = new Set(['transparent', 'inherit', 'initial', 'unset', 'revert', 'currentcolor', 'none', 'auto']);

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHex(value: string): Rgb | null {
  const hex = value.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const expand = (c: string) => parseInt(c + c, 16);
  if (hex.length === 3 || hex.length === 4) {
    return {
      r: expand(hex[0]),
      g: expand(hex[1]),
      b: expand(hex[2]),
      ...(hex.length === 4 ? { a: expand(hex[3]) / 255 } : {})
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      ...(hex.length === 8 ? { a: parseInt(hex.slice(6, 8), 16) / 255 } : {})
    };
  }
  return null;
}

function parseAlpha(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const value = token.trim();
  if (!value) return undefined;
  if (value.endsWith('%')) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : undefined;
}

function parseChannel(token: string, max: number): number | null {
  const value = token.trim();
  if (!value) return null;
  if (value.endsWith('%')) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * max : null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseRgbFunction(body: string): Rgb | null {
  const cleaned = body.replace('/', ' ').replace(/,/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0], 255);
  const g = parseChannel(parts[1], 255);
  const b = parseChannel(parts[2], 255);
  if (r === null || g === null || b === null) return null;
  const a = parseAlpha(parts[3]);
  return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b), ...(a !== undefined ? { a } : {}) };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clampChannel((r + m) * 255), g: clampChannel((g + m) * 255), b: clampChannel((b + m) * 255) };
}

function parseHslFunction(body: string): Rgb | null {
  const cleaned = body.replace('/', ' ').replace(/,/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseChannel(parts[0], 360);
  const s = parseChannel(parts[1], 100);
  const l = parseChannel(parts[2], 100);
  if (h === null || s === null || l === null) return null;
  const rgb = hslToRgb(h, s / 100, l / 100);
  const a = parseAlpha(parts[3]);
  return a !== undefined ? { ...rgb, a } : rgb;
}

function rgbToHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return { h: ((h % 360) + 360) % 360, s, l };
}

/** Parses a CSS colour (hex, rgb/rgba, hsl/hsla, or a common named colour). */
export function parseCssColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw || NON_COLORS.has(raw)) return null;
  if (raw.startsWith('#')) return parseHex(raw);

  const named = NAMED_COLORS[raw];
  if (named) return parseHex(named);

  const fn = raw.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (fn) {
    const body = fn[2];
    return fn[1].startsWith('rgb') ? parseRgbFunction(body) : parseHslFunction(body);
  }
  return null;
}

/** WCAG relative luminance. */
export function relativeLuminance(c: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function rgbToCss(c: Rgb): string {
  const r = clampChannel(c.r);
  const g = clampChannel(c.g);
  const b = clampChannel(c.b);
  const a = c.a;
  if (a !== undefined && a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  return `rgb(${r}, ${g}, ${b})`;
}

/** Light background → same hue/saturation at a surface-dark lightness. */
export function darkenForDarkMode(c: Rgb): Rgb {
  const { h, s } = rgbToHsl(c);
  const targetL = 0.15 + 0.1 * s;
  return { ...hslToRgb(h, s, targetL), ...(c.a !== undefined ? { a: c.a } : {}) };
}

/** Dark inline text → same hue/saturation at a light lightness. */
export function lightenForDarkMode(c: Rgb): Rgb {
  const { h, s } = rgbToHsl(c);
  const targetL = s < 0.1 ? 0.88 : 0.8;
  return { ...hslToRgb(h, s, targetL), ...(c.a !== undefined ? { a: c.a } : {}) };
}

/**
 * Rewrites a background colour value when it is too light for dark mode.
 * Returns null when the value is not a colour or already dark enough.
 */
export function darkenBackgroundForDarkMode(value: string | null | undefined): string | null {
  const rgb = parseCssColor(value);
  if (!rgb) return null;
  if (relativeLuminance(rgb) <= LIGHT_THRESHOLD) return null;
  return rgbToCss(darkenForDarkMode(rgb));
}

/**
 * Rewrites a text colour value when it is too dark for dark mode.
 * Returns null when the value is not a colour or already light enough.
 */
export function lightenTextForDarkMode(value: string | null | undefined): string | null {
  const rgb = parseCssColor(value);
  if (!rgb) return null;
  if (relativeLuminance(rgb) >= DARK_TEXT_THRESHOLD) return null;
  return rgbToCss(lightenForDarkMode(rgb));
}

/** Properties carrying a background colour we may need to darken. */
const BACKGROUND_PROPERTIES = new Set(['background-color', 'background']);

/**
 * Rewrites the declarations of one inline `style` attribute for dark mode.
 * Unknown/short-circuited values are preserved verbatim.
 */
export function convertStyleAttributeForDark(style: string): string {
  const declarations = style.split(';').map((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon === -1) return declaration;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    let setting = declaration.slice(colon + 1).trim();
    if (!setting) return declaration;

    // Keep a trailing `!important` out of the colour value (and re-append it).
    const important = setting.match(/^(.*?)\s*!important\s*$/i);
    if (important) setting = important[1].trim();
    const suffix = important ? ' !important' : '';
    if (!setting) return declaration;

    if (BACKGROUND_PROPERTIES.has(property)) {
      // `background` may carry images/positions; parseCssColor rejects those,
      // so the declaration is preserved untouched.
      const darkened = darkenBackgroundForDarkMode(setting);
      if (darkened) return `${property}: ${darkened}${suffix}`;
      return declaration;
    }
    if (property === 'color') {
      const lightened = lightenTextForDarkMode(setting);
      if (lightened) return `${property}: ${lightened}${suffix}`;
      return declaration;
    }
    return declaration;
  });
  return declarations.join(';');
}

/**
 * Converts every light inline background / dark inline text colour in a block
 * of rendered HTML to its dark-mode equivalent. Client-only (uses DOMParser)
 * and a no-op when the markup carries no inline styles at all.
 */
export function convertInlineStylesForDark(html: string): string {
  if (!html) return html;
  if (typeof DOMParser === 'undefined') return html;
  if (!/style=|bgcolor=/i.test(html)) return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return html;

  for (const element of Array.from(doc.body.querySelectorAll('[style], [bgcolor]'))) {
    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', convertStyleAttributeForDark(style));

    const bgcolor = element.getAttribute('bgcolor');
    if (bgcolor) {
      const darkened = darkenBackgroundForDarkMode(bgcolor);
      if (darkened) element.setAttribute('style', appendDeclaration(element.getAttribute('style'), `background-color: ${darkened}`));
      element.removeAttribute('bgcolor');
    }
  }

  return doc.body.innerHTML;
}

function appendDeclaration(style: string | null, declaration: string): string {
  const base = style?.trim();
  if (!base) return declaration;
  return base.endsWith(';') ? `${base} ${declaration}` : `${base}; ${declaration}`;
}
