import * as THREE from 'three';
import { WALL_MAX } from './cpu';

export type Check = 'overhang' | 'wall' | 'distance';

/** Settings the colour maps read; editable in the UI. */
export const thresholds = { thinWall: 1.2, overhang: 45, distRange: 0.5, distTol: 0.02 };

const NEUTRAL = new THREE.Color(0.78, 0.78, 0.76);
const RED = new THREE.Color(0xe0413a), ORANGE = new THREE.Color(0xf08c3a), YELLOW = new THREE.Color(0xe8d44d);
const GREEN = new THREE.Color(0x5fbf6a), TEAL = new THREE.Color(0x4fa3bf), BLUE = new THREE.Color(0x3b6fd8);

const lerp3 = (stops: [number, THREE.Color][], t: number, out: THREE.Color) => {
  if (t <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
};

/** Ordered within 0-90 for any allowed threshold (20-80). */
const overhangStops = (): [number, THREE.Color][] => {
  const o = thresholds.overhang;
  return [[o - 10, NEUTRAL], [o, YELLOW], [o + (90 - o) / 2, ORANGE], [90, RED]];
};

export function colour(w: Check, v: number, out: THREE.Color): THREE.Color {
  const th = thresholds;
  if (w === 'wall') {
    if (v >= WALL_MAX - 1e-3) return out.copy(NEUTRAL).multiplyScalar(0.8); // ray escaped: open mesh or very thick
    return lerp3([[0, RED], [th.thinWall * 0.5, RED], [th.thinWall, YELLOW], [th.thinWall * 2, GREEN], [th.thinWall * 6, TEAL]], v, out);
  }
  if (w === 'overhang') {
    if (v <= th.overhang - 10) return out.copy(NEUTRAL);
    return lerp3(overhangStops(), v, out);
  }
  if (Math.abs(v) <= th.distTol) return out.copy(NEUTRAL);
  const t = Math.min(1, Math.abs(v) / th.distRange);
  return out.copy(NEUTRAL).lerp(v > 0 ? RED : BLUE, 0.25 + 0.75 * t);
}

/** CSS gradient + tick labels for the legend. */
export function legend(w: Check): { gradient: string; ticks: string[] } {
  const th = thresholds;
  const css = (c: THREE.Color) => `#${c.getHexString()}`;
  if (w === 'wall') return {
    gradient: `linear-gradient(90deg, ${css(RED)} 0%, ${css(RED)} 8%, ${css(YELLOW)} 17%, ${css(GREEN)} 33%, ${css(TEAL)} 100%)`,
    ticks: ['0', `${th.thinWall} mm (thin)`, `${+(th.thinWall * 2).toFixed(2)}`, `${+(th.thinWall * 6).toFixed(2)}+ mm`],
  };
  if (w === 'overhang') return {
    gradient: `linear-gradient(90deg, ${overhangStops().map(([x, c]) => `${css(c)} ${((x / 90) * 100).toFixed(1)}%`).join(', ')})`,
    ticks: ['0°', `${th.overhang}°`, '90° (ceiling)'],
  };
  return {
    gradient: `linear-gradient(90deg, ${css(BLUE)} 0%, ${css(NEUTRAL)} 50%, ${css(RED)} 100%)`,
    ticks: [`−${th.distRange} mm (removed)`, '0', `+${th.distRange} mm (added)`],
  };
}
