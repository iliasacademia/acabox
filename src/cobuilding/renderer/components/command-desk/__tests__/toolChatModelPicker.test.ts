import * as fs from 'fs';
import * as path from 'path';

/**
 * A chat opened beside a tool must be able to choose its model.
 *
 * The docked `GlobalComposer` is the only place the picker used to live, and
 * `index.tsx` hides that composer in mini-app detail view — so a chat started
 * from a tool's side panel silently took whatever `getSelectedModel()` last
 * returned, with no control anywhere on screen to change it. The panel header
 * already carried a `MODEL · EFFORT` line, so the picker replaces that line
 * rather than crowding the 320px-wide composer row.
 *
 * Asserted against the sources because `ToolWorkspace.tsx` cannot be imported
 * under jest (`@assistant-ui/react` pulls in ESM-only `assistant-stream`), and
 * because both halves are needed: the component renders it, the stylesheet
 * makes it read as the meta row it replaced.
 */

const dir = path.join(__dirname, '..');
const TOOL_WORKSPACE = fs.readFileSync(path.join(dir, 'ToolWorkspace.tsx'), 'utf8');
const PHASE_B = fs.readFileSync(path.join(dir, '..', '..', 'phaseB.css'), 'utf8');

describe('tool side-panel model picker', () => {
  it('the side panel header renders the shared ModelSelector', () => {
    expect(TOOL_WORKSPACE).toMatch(/import \{ ModelSelector \} from '\.\.\/ModelSelector';/);
    expect(TOOL_WORKSPACE).toMatch(/<ModelSelector \/>/);
  });

  it('mounts it as the header meta row, not as a second control elsewhere', () => {
    expect(TOOL_WORKSPACE).toMatch(
      /className="cdSidePanel__meta"[^>]*>\s*<ModelSelector \/>/,
    );
    // Exactly one — a second copy would register a second model-context
    // provider for the same runtime.
    expect(TOOL_WORKSPACE.match(/<ModelSelector \/>/g)).toHaveLength(1);
  });

  it('restyles the trigger for that row instead of leaving it a composer chip', () => {
    // Unscoped, the shared trigger keeps `.selectTrigger`-era borders from
    // App.css and towers over a 10px mono line.
    expect(PHASE_B).toContain('.cdSidePanel__meta .modelSelectorTrigger');
    // Chained with the row class so import order cannot decide the tie
    // against commandDesk.css's `.cdComposerField .modelSelectorTrigger`.
    expect(PHASE_B).not.toMatch(/^\.modelSelectorTrigger\s*\{/m);
  });

  it('drops the hover affordance once the chat is pinned', () => {
    expect(PHASE_B).toContain('.cdSidePanel__meta .modelSelectorTrigger--pinned');
    const pinned = PHASE_B.slice(PHASE_B.indexOf('.cdSidePanel__meta .modelSelectorTrigger--pinned'));
    expect(pinned.slice(0, pinned.indexOf('}'))).toContain('cursor: default');
  });
});
