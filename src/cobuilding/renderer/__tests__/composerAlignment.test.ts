import * as fs from 'fs';
import * as path from 'path';

/**
 * The side-panel composer lays its controls out with `align-items: flex-end`,
 * so nothing shares a centre line automatically — each control has to be
 * pushed up off the bottom edge by its own `margin-bottom`. The glyph uses
 * 14px, the send button 7px, and both land on the same centre.
 *
 * The mic button arrived without one. It is a `.cdIconBtn`, and the rule that
 * compensates for the docked composer (`.cdComposerField .cdIconBtn`) is
 * scoped to *that* composer's field class, which this one does not use — so
 * the mic rendered 28px tall, flush to the bottom, with its centre 8px below
 * the send button's. That is the misalignment visible in the shipped UI.
 *
 * This test pins the relationship rather than the numbers: whatever box the
 * send button has, the mic must have the same one. Changing the composer's
 * height only breaks it if the two are changed apart.
 */

// Both sheets: the panel composer is styled in phaseB.css, the docked one and
// the shared `.cdIconBtn` base in commandDesk.css.
const CSS = ['phaseB.css', 'commandDesk.css']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
  .join('\n');

function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`rule not found: ${selector}`);
  const out: Record<string, string> = {};
  for (const decl of m[1].split(';')) {
    const [k, ...v] = decl.split(':');
    if (!k?.trim() || !v.length) continue;
    out[k.trim()] = v.join(':').trim();
  }
  return out;
}

describe('side-panel composer control alignment', () => {
  const field = rule('.cdPanelComposer__field');
  const send = rule('.cdPanelComposer__send');
  const mic = rule('.cdPanelComposer__field .cdIconBtn');

  it('still lays out from the bottom edge (the reason offsets are needed)', () => {
    expect(field['align-items']).toBe('flex-end');
  });

  it('gives the mic the same box as the send button', () => {
    expect(mic.width).toBe(send.width);
    expect(mic.height).toBe(send.height);
  });

  it('gives the mic the same bottom offset as the send button', () => {
    // Equal box + equal bottom offset in a flex-end row is exactly the
    // condition for a shared centre line.
    expect(mic['margin-bottom']).toBe(send['margin-bottom']);
    expect(mic['margin-bottom']).toBeTruthy();
  });

  it('does not rely on the docked composer\'s rule, which is scoped elsewhere', () => {
    // If someone "simplifies" by widening `.cdComposerField .cdIconBtn` to
    // cover both composers, its 11px offset would be wrong here (the docked
    // composer's field is taller), so the two must stay separate rules.
    const docked = rule('.cdComposerField .cdIconBtn');
    expect(docked['margin-bottom']).not.toBe(mic['margin-bottom']);
  });
});
