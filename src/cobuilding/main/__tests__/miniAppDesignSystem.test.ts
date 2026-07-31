import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the mini-app design system against silent drift.
 *
 * A mini-app renders in a `local-file://` iframe and inherits nothing from the
 * host renderer, so the Command Desk tokens have to be *copied* into
 * `skills/manage-mini-application/assets/vendor/acabox.css`. A copy with no
 * check on it is a copy that goes stale — and the failure mode is quiet, since
 * both files stay individually valid while apps slowly drift off-palette. That
 * has already happened once: the previous guidance pinned `#faf8f5` as "the
 * host's nav-bar colour" long after the host had stopped using it anywhere.
 *
 * These are file-content assertions rather than rendering tests on purpose.
 * The assets are excluded from the tsc project and are bundled per-app by
 * esbuild, so nothing else in `npm test` looks at them at all.
 */

const REPO = path.join(__dirname, '..', '..', '..', '..');
const HOST_CSS = path.join(REPO, 'src/cobuilding/renderer/commandDesk.css');
const SKILL = path.join(REPO, 'src/cobuilding/skills/manage-mini-application');
const APP_CSS = path.join(SKILL, 'assets/vendor/acabox.css');
const SCAFFOLD = path.join(SKILL, 'scripts/manage_mini_app.mjs');
const PLOT_THEME = path.join(SKILL, 'assets/reusable/plotTheme.ts');

const read = (p: string) => fs.readFileSync(p, 'utf8');

function tokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/^\s*(--cd-[a-z0-9-]+):\s*([^;]+);/gm)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

describe('mini-app design tokens track the host', () => {
  const host = tokens(read(HOST_CSS));
  const app = tokens(read(APP_CSS));

  it('defines a non-trivial token set on both sides', () => {
    expect(Object.keys(host).length).toBeGreaterThan(10);
    expect(Object.keys(app).length).toBeGreaterThan(10);
  });

  it('gives every shared token the same value as commandDesk.css', () => {
    const shared = Object.keys(app).filter((k) => k in host);
    // Guards against the test passing because the two stopped overlapping.
    expect(shared.length).toBeGreaterThan(10);
    const drift = shared
      .filter((k) => app[k] !== host[k])
      .map((k) => `${k}: mini-app ${app[k]} vs host ${host[k]}`);
    expect(drift).toEqual([]);
  });

  it('carries the colour tokens a mini-app actually needs', () => {
    for (const t of ['--cd-ink', '--cd-text2', '--cd-text3', '--cd-border',
      '--cd-blue', '--cd-pale', '--cd-error', '--cd-error-bg']) {
      expect(app[t]).toBeTruthy();
    }
  });
});

describe('the Coscientist palette is gone', () => {
  it('no file the agent reads still prescribes #faf8f5', () => {
    // The old page colour, justified in prose as matching the host chrome. It
    // matches nothing in Acabox — leaving it anywhere teaches it again.
    //
    // Naming it to mark it stale is allowed, and is the point: an agent
    // editing a pre-design-system app will literally read `bg-[#faf8f5]` off
    // that app's source and needs to be told it is wrong. So the guard is on
    // *prescriptive* uses — a mention must say on the same line that it is
    // stale, or it counts as an offender.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(md|tsx?|mjs|css|json)$/.test(e.name)) continue;
        for (const line of read(p).split('\n')) {
          if (!line.includes('faf8f5')) continue;
          if (/\bstale\b/i.test(line)) continue;
          offenders.push(`${path.relative(REPO, p)}: ${line.trim().slice(0, 90)}`);
        }
      }
    };
    walk(path.join(REPO, 'src/cobuilding/skills'));
    expect(offenders).toEqual([]);
  });
});

describe('the scaffold wires the design system in', () => {
  const scaffold = read(SCAFFOLD);

  it('links acabox.css before Tailwind so utilities win on ties', () => {
    const link = scaffold.indexOf('_vendor/acabox.css');
    const tw = scaffold.indexOf('_vendor/tailwind.js');
    expect(link).toBeGreaterThan(-1);
    expect(tw).toBeGreaterThan(-1);
    expect(link).toBeLessThan(tw);
  });

  it('no longer sets system-ui as the app font', () => {
    expect(scaffold).not.toContain('system-ui');
  });

  it('remaps the Tailwind scales an agent reaches for by reflex', () => {
    // The prose asks for `text-ink`; habit produces `text-gray-500`. The remap
    // is what makes the habit land on-palette, so it is load-bearing.
    for (const scale of ['gray:', 'slate:', 'blue:', 'red:', 'amber:', 'green:']) {
      expect(scaffold).toContain(scale);
    }
    expect(scaffold).toContain('"DM Sans"');
    expect(scaffold).toContain('"IBM Plex Mono"');
  });
});

describe('the bridge back-fills apps that predate the stylesheet', () => {
  it('bridge.ts imports the design-system installer', () => {
    expect(read(path.join(SKILL, 'assets/bridge/bridge.ts')))
      .toContain('./design-system');
  });

  it('the installer appends to <head> rather than prepending', () => {
    // Legacy scaffolds carry an inline `body { font-family: system-ui }`.
    // Both are element selectors, so only document order separates them — a
    // prepended sheet would lose and the app would stay in the wrong font.
    const src = read(path.join(SKILL, 'assets/bridge/design-system.ts'));
    expect(src).toContain('appendChild');
    expect(src).not.toContain('insertBefore');
  });
});

describe('fonts ship with the skill', () => {
  const fontsDir = path.join(SKILL, 'assets/vendor/fonts');

  it.each(['DM-Sans.woff2', 'IBMPlexMono-Regular.woff2', 'IBMPlexMono-Medium.woff2'])(
    'ships %s', (f) => {
      expect(fs.existsSync(path.join(fontsDir, f))).toBe(true);
    });

  it('references them by a path relative to the stylesheet', () => {
    // url() resolves against the stylesheet, not the document, which is what
    // lets one copy serve apps at any directory depth.
    expect(read(APP_CSS)).toContain("url('./fonts/DM-Sans.woff2')");
  });

  it('does not ship Material Symbols — mini-apps use lucide', () => {
    // 281 KB, and nothing in a mini-app renders a ligature icon.
    expect(fs.existsSync(path.join(fontsDir, 'MaterialSymbolsOutlined.woff2'))).toBe(false);
  });
});

describe('the chart palette stays at its validated size', () => {
  const theme = read(PLOT_THEME);

  it('keeps exactly six categorical hues', () => {
    const block = theme.match(/ACABOX_CATEGORICAL = \[([\s\S]*?)\] as const/)![1];
    const hues = block.match(/"#[0-9a-fA-F]{6}"/g) ?? [];
    // Six is a measured ceiling, not a style preference: a seventh hue was
    // tried and collided with two existing ones under simulated CVD. Adding
    // one here without re-running the dataviz validator re-introduces a
    // palette that colourblind readers cannot separate.
    expect(hues).toHaveLength(6);
    expect(hues[0]).toBe('"#0645b1"');
  });

  it('puts a neutral gray at the diverging midpoint', () => {
    const block = theme.match(/ACABOX_DIVERGING = \[([\s\S]*?)\] as const/)![1];
    const steps = (block.match(/"#[0-9a-fA-F]{6}"/g) ?? []);
    expect(steps).toHaveLength(7);
    expect(steps[3]).toBe('"#ebebee"');
  });

  it('has one definition of the regulation colours', () => {
    // `@reusable/types` used to hold a second, different set.
    expect(read(path.join(SKILL, 'assets/reusable/types.ts')))
      .toContain('REGULATION_COLORS as COLORS');
  });
});
