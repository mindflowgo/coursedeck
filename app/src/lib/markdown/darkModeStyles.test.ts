import { describe, expect, it } from 'bun:test';
import {
  convertStyleAttributeForDark,
  darkenBackgroundForDarkMode,
  darkenForDarkMode,
  lightenTextForDarkMode,
  parseCssColor,
  relativeLuminance,
  rgbToCss
} from './darkModeStyles';

describe('parseCssColor', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor('#eceff0')).toEqual({ r: 236, g: 239, b: 240 });
  });

  it('parses and preserves alpha from 4- and 8-digit hex', () => {
    expect(parseCssColor('#ffffff00')).toEqual({ r: 255, g: 255, b: 255, a: 0 });
    expect(parseCssColor('#fff0')).toEqual({ r: 255, g: 255, b: 255, a: 0 });
    expect(parseCssColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('parses rgb/rgba in comma and space syntax', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseCssColor('rgba(1 2 3 / 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses hsl', () => {
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor('hsl(120 100% 50%)')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('parses common named colours, case-insensitively', () => {
    expect(parseCssColor('White')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor('red')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('rejects non-colours', () => {
    for (const value of ['', 'transparent', 'inherit', 'currentColor', 'url(x.png)', 'none', 'bogus']) {
      expect(parseCssColor(value)).toBeNull();
    }
  });
});

describe('relativeLuminance', () => {
  it('ranks white above the light threshold and red below it', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 0, b: 0 })).toBeLessThan(0.5);
  });
});

describe('darkenBackgroundForDarkMode', () => {
  it('darkens the light grey used by course tables', () => {
    const result = darkenBackgroundForDarkMode('#eceff0');
    expect(result).not.toBeNull();
    if (result) expect(relativeLuminance(parseCssColor(result)!)).toBeLessThan(0.3);
  });

  it('darkens white and silver', () => {
    expect(darkenBackgroundForDarkMode('#ffffff')).not.toBeNull();
    expect(darkenBackgroundForDarkMode('silver')).not.toBeNull();
  });

  it('leaves already-dark backgrounds alone', () => {
    expect(darkenBackgroundForDarkMode('red')).toBeNull();
    expect(darkenBackgroundForDarkMode('#333333')).toBeNull();
    expect(darkenBackgroundForDarkMode('#808080')).toBeNull();
  });

  it('returns null for images and non-colours', () => {
    expect(darkenBackgroundForDarkMode('url(bg.png) no-repeat')).toBeNull();
    expect(darkenBackgroundForDarkMode('transparent')).toBeNull();
    expect(darkenBackgroundForDarkMode(null)).toBeNull();
  });

  it('preserves hue when darkening', () => {
    const darkened = darkenBackgroundForDarkMode('#ffd700');
    const rgb = parseCssColor(darkened!);
    expect(rgb!.r).toBeGreaterThan(rgb!.b);
  });
});

describe('lightenTextForDarkMode', () => {
  it('lightens dark text', () => {
    const result = lightenTextForDarkMode('#222222');
    expect(result).not.toBeNull();
    if (result) expect(relativeLuminance(parseCssColor(result)!)).toBeGreaterThan(0.5);
  });

  it('leaves already-light text alone', () => {
    expect(lightenTextForDarkMode('#ffffff')).toBeNull();
    expect(lightenTextForDarkMode('#cccccc')).toBeNull();
  });
});

describe('convertStyleAttributeForDark', () => {
  it('darkens background-color and preserves unrelated declarations', () => {
    const out = convertStyleAttributeForDark('background-color: #eceff0; width: 20%');
    expect(out).toContain('width: 20%');
    expect(out).not.toContain('#eceff0');
    expect(out).toContain('background-color: rgb(');
  });

  it('lightens dark colour and leaves dark backgrounds untouched', () => {
    const out = convertStyleAttributeForDark('color: #000000; background-color: red');
    expect(out).toContain('background-color: red');
    expect(out).toContain('color: rgb(');
    expect(out).not.toContain('#000000');
  });

  it('keeps malformed declarations as-is', () => {
    expect(convertStyleAttributeForDark('width')).toBe('width');
    expect(convertStyleAttributeForDark('background-color: url(x)')).toBe('background-color: url(x)');
  });

  it('converts values that carry !important', () => {
    const out = convertStyleAttributeForDark('background-color: #ffffff !important');
    expect(out).toContain('!important');
    expect(out).not.toContain('#ffffff');
  });

  it('preserves alpha when darkening translucent backgrounds', () => {
    const out = convertStyleAttributeForDark('background-color: rgba(255, 255, 255, 0.1)');
    expect(out).toMatch(/^background-color: rgba\(\d+, \d+, \d+, 0\.1\)$/);
  });
});

describe('darkenForDarkMode / rgbToCss', () => {
  it('produces a dark value and a serializable string', () => {
    const rgb = darkenForDarkMode(parseCssColor('#eceff0')!);
    expect(relativeLuminance(rgb)).toBeLessThan(0.2);
    expect(rgbToCss(rgb)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});
