/**
 * CIEDE2000 color difference.
 *
 * The standard perceptual color-distance metric. ~3.5 is a "just noticeable
 * difference" under controlled viewing conditions; 1.0 is well below the
 * threshold of perception for most observers.
 *
 * Reference: Sharma, Wu, Dalal (2005) "The CIEDE2000 Color-Difference
 * Formula: Implementation Notes, Supplementary Test Data, and Mathematical
 * Observations".
 */

import type { LAB } from './color.js';

export function deltaE2000(lab1: LAB, lab2: LAB): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;

  const G =
    0.5 *
    (1 -
      Math.sqrt(
        Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))
      ));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;

  const h1p = ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360;
  const h2p = ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;

  let avgHp: number;
  if (Math.abs(h1p - h2p) > 180) avgHp = (h1p + h2p + 360) / 2;
  else avgHp = (h1p + h2p) / 2;

  const T =
    1 -
    0.17 * Math.cos(((avgHp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * avgHp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);

  let dhp = h2p - h1p;
  if (Math.abs(dhp) > 180) dhp -= dhp > 0 ? 360 : -360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(((dhp / 2) * Math.PI) / 180);

  const SL =
    1 +
    (0.015 * Math.pow(avgL - 50, 2)) /
      Math.sqrt(20 + Math.pow(avgL - 50, 2));
  const SC = 1 + 0.045 * avgCp;
  const SH = 1 + 0.015 * avgCp * T;

  const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
  const RC =
    2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const RT = -RC * Math.sin((2 * dTheta * Math.PI) / 180);

  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH)
  );
}
