const CB_COLORS = [
  { family: 'blue-light',   base: '#a6cee3' },
  { family: 'blue',         base: '#1f78b4' },
  { family: 'green-light',  base: '#b2df8a' },
  { family: 'green',        base: '#33a02c' },
  { family: 'red-light',    base: '#fb9a99' },
  { family: 'red',          base: '#e31a1c' },
  { family: 'orange-light', base: '#fdbf6f' },
  { family: 'orange',       base: '#ff7f00' },
  { family: 'purple-light', base: '#cab2d6' },
  { family: 'purple',       base: '#6a3d9a' },
  { family: 'yellow',       base: '#ffff99' },
  { family: 'brown',        base: '#b15928' },
] as const;

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b]
    .map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('');
}

function lerp(hex: string, target: [number, number, number], t: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r + (target[0] - r) * t, g + (target[1] - g) * t, b + (target[2] - b) * t);
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

function makeShades(base: string) {
  return {
    100: lerp(base, WHITE, 0.75),
    200: lerp(base, WHITE, 0.5),
    400: lerp(base, WHITE, 0.2),
    600: base,
    700: lerp(base, BLACK, 0.2),
    900: lerp(base, BLACK, 0.5),
  };
}

export const PLAN_COLORS = CB_COLORS.map(({ family, base }) => ({
  family,
  shades: makeShades(base),
}));

export const AUTO_COLORS = PLAN_COLORS.map(f => f.shades[600]);

export function nextAutoColor(existingColors: string[]): string {
  const idx = AUTO_COLORS.findIndex(c => !existingColors.includes(c));
  return idx >= 0 ? AUTO_COLORS[idx] : AUTO_COLORS[existingColors.length % AUTO_COLORS.length];
}
