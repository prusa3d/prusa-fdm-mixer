import { describe, expect, it } from 'vitest';
import {
  mixFilaments,
  mixLinearRgb,
  mixKubelkaMunk,
  mixFilamentMixer,
  hexToRgb,
  rgbToHex,
  hexToLab,
  labToHex,
  deltaE2000,
} from '../src/index.js';

describe('color space round-trips', () => {
  it('hex → rgb → hex is identity', () => {
    expect(rgbToHex(hexToRgb('#009bc3'))).toBe('#009bc3');
    expect(rgbToHex(hexToRgb('#ff6338'))).toBe('#ff6338');
    expect(rgbToHex(hexToRgb('#000000'))).toBe('#000000');
    expect(rgbToHex(hexToRgb('#ffffff'))).toBe('#ffffff');
  });

  it('hex → lab → hex is identity within ΔE < 0.5', () => {
    const samples = ['#009bc3', '#f6b921', '#c9378c', '#ff6338', '#347644'];
    for (const hex of samples) {
      const lab = hexToLab(hex);
      const back = labToHex(lab);
      expect(deltaE2000(lab, hexToLab(back))).toBeLessThan(0.5);
    }
  });
});

describe('deltaE2000', () => {
  it('returns 0 for identical colors', () => {
    const lab = { L: 50, a: 20, b: -30 };
    expect(deltaE2000(lab, lab)).toBeCloseTo(0, 5);
  });

  it('is symmetric', () => {
    const a = hexToLab('#009bc3');
    const b = hexToLab('#f6b921');
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 5);
  });
});

describe('mixFilaments — pure components', () => {
  it('returns the input exactly when ratio is 1', () => {
    const result = mixFilaments([{ hex: '#009bc3', ratio: 1 }]);
    expect(result.hex).toBe('#009bc3');
  });

  it('returns the input even when ratio is slightly off (gradient safety)', () => {
    const result = mixFilaments([{ hex: '#009bc3', ratio: 0.99995 }]);
    expect(result.hex).toBe('#009bc3');
  });

  it('returns the dominant input when one ratio is effectively 0', () => {
    const result = mixFilaments([
      { hex: '#009bc3', ratio: 0.99999 },
      { hex: '#f6b921', ratio: 0.00001 },
    ]);
    // Should be very close to cyan since the yellow contribution is negligible.
    expect(deltaE2000(hexToLab(result.hex), hexToLab('#009bc3'))).toBeLessThan(2);
  });
});

describe('mixFilaments — known reference predictions', () => {
  // Reference outputs captured from the calibrated v7 model. These are
  // pinned to catch regressions in the model itself, not to compare against
  // measured colors (use the harness app for that).
  const cases: Array<{ name: string; parts: Array<[string, number]>; expected: string }> = [
    { name: 'cyan + yellow 50:50', parts: [['#009bc3', 0.5], ['#f6b921', 0.5]], expected: '#519e5f' },
    { name: 'cyan + magenta 50:50', parts: [['#009bc3', 0.5], ['#c9378c', 0.5]], expected: '#4a5e94' },
    { name: 'magenta + yellow 50:50', parts: [['#c9378c', 0.5], ['#f6b921', 0.5]], expected: '#cc6545' },
  ];

  for (const c of cases) {
    it(`matches reference for ${c.name}`, () => {
      const result = mixFilaments(c.parts.map(([hex, ratio]) => ({ hex, ratio })));
      expect(result.hex).toBe(c.expected);
    });
  }
});

describe('mixFilaments — gradient continuity', () => {
  it('produces smooth output across a 2-color gradient', () => {
    const steps = 11;
    const colors: string[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const r = mixFilaments([
        { hex: '#009bc3', ratio: 1 - t },
        { hex: '#f6b921', ratio: t },
      ]);
      colors.push(r.hex);
    }
    // The first and last should be the pure components.
    expect(colors[0]).toBe('#009bc3');
    expect(colors[steps - 1]).toBe('#f6b921');
    // No two consecutive steps should jump by more than ΔE 30.
    for (let i = 1; i < colors.length; i++) {
      const dE = deltaE2000(hexToLab(colors[i - 1]!), hexToLab(colors[i]!));
      expect(dE).toBeLessThan(30);
    }
  });
});

describe('mixFilaments — input validation', () => {
  it('throws on empty parts', () => {
    expect(() => mixFilaments([])).toThrow();
  });

  it('throws on negative ratios', () => {
    expect(() =>
      mixFilaments([
        { hex: '#000000', ratio: 0.5 },
        { hex: '#ffffff', ratio: -0.1 },
      ])
    ).toThrow();
  });

  it('throws on all-zero ratios', () => {
    expect(() =>
      mixFilaments([
        { hex: '#000000', ratio: 0 },
        { hex: '#ffffff', ratio: 0 },
      ])
    ).toThrow();
  });

  it('handles unnormalized ratios (renormalizes)', () => {
    const a = mixFilaments([
      { hex: '#009bc3', ratio: 1 },
      { hex: '#f6b921', ratio: 1 },
    ]);
    const b = mixFilaments([
      { hex: '#009bc3', ratio: 0.5 },
      { hex: '#f6b921', ratio: 0.5 },
    ]);
    expect(a.hex).toBe(b.hex);
  });
});

describe('comparison models — basic sanity', () => {
  const parts = [
    { hex: '#009bc3', ratio: 0.5 },
    { hex: '#f6b921', ratio: 0.5 },
  ];

  it('mixLinearRgb returns a valid hex', () => {
    expect(mixLinearRgb(parts).hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('mixKubelkaMunk returns a valid hex', () => {
    expect(mixKubelkaMunk(parts).hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('mixFilamentMixer returns a valid hex', () => {
    expect(mixFilamentMixer(parts).hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('all models return pure A when ratio is 1', () => {
    const partsA = [{ hex: '#009bc3', ratio: 1 }];
    expect(mixLinearRgb(partsA).hex).toBe('#009bc3');
    expect(mixKubelkaMunk(partsA).hex).toBe('#009bc3');
    expect(mixFilamentMixer(partsA).hex).toBe('#009bc3');
  });
});
