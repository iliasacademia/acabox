/**
 * The layout rules for collapsed steps — which parts fold together, which stay
 * visible, where the final answer starts, and what the one-line summaries say.
 * The React half (`turn-steps.tsx`) cannot be imported under jest
 * (`@assistant-ui/react` is ESM-only), so everything that DECIDES layout lives
 * in `turnSteps.ts` and is pinned here; the rendering is verified live.
 */
import {
  finalAnswerStart,
  formatWorkedFor,
  isFailed,
  isOutcomePart,
  segmentParts,
  summarizeSteps,
  turnFoldLabel,
  type PartLite,
} from '../turnSteps';

const text = (t = 'prose'): PartLite => ({ type: 'text', text: t });
const tool = (toolName: string, extra: Partial<PartLite> = {}): PartLite => ({ type: 'tool-call', toolName, ...extra });
const bash = (command = 'ls') => tool('Bash', { args: { command } });

describe('segmentParts', () => {
  it('collapses each run of tool calls between prose into one segment', () => {
    const parts = [text(), bash(), bash(), text(), tool('Read'), tool('Write'), bash(), text()];
    expect(segmentParts(parts)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'steps', start: 1, end: 2 },
      { kind: 'part', index: 3 },
      { kind: 'steps', start: 4, end: 6 },
      { kind: 'part', index: 7 },
    ]);
  });

  it('keeps thinking and blank text inside a run instead of splitting it', () => {
    // A signature-only thinking block or a whitespace text part between two
    // calls would otherwise print two identical summary lines back to back.
    const parts = [bash(), { type: 'reasoning' }, text('  \n'), bash()];
    expect(segmentParts(parts)).toEqual([{ kind: 'steps', start: 0, end: 3 }]);
  });

  it('honours the precomputed blank flag the renderer passes instead of text', () => {
    const parts: PartLite[] = [bash(), { type: 'text', blank: true }, bash()];
    expect(segmentParts(parts)).toEqual([{ kind: 'steps', start: 0, end: 2 }]);
  });
});

describe('finalAnswerStart', () => {
  it('is the first part after the last tool call', () => {
    expect(finalAnswerStart([text(), bash(), text(), bash(), text(), text()])).toBe(4);
  });
  it('folds everything when the turn ends on a tool call', () => {
    const parts = [text(), bash()];
    expect(finalAnswerStart(parts)).toBe(parts.length);
  });
  it('is 0 when no tool was used', () => {
    expect(finalAnswerStart([text()])).toBe(0);
  });
});

describe('isOutcomePart — results stay out of every fold', () => {
  it('keeps mini-app cards and plan prompts visible', () => {
    const parts = [tool('mcp__mini-apps__build_and_open_mini_application'), tool('EnterPlanMode'), bash()];
    expect(isOutcomePart(parts, 0)).toBe(true);
    expect(isOutcomePart(parts, 1)).toBe(true);
    expect(isOutcomePart(parts, 2)).toBe(false);
  });

  it('keeps only the LAST checklist visible; earlier ones are superseded steps', () => {
    const parts = [tool('TodoWrite'), bash(), tool('TodoWrite'), bash(), tool('TodoWrite')];
    expect([0, 2, 4].map((i) => isOutcomePart(parts, i))).toEqual([false, false, true]);
  });

  it('never treats prose as an outcome', () => {
    expect(isOutcomePart([text()], 0)).toBe(false);
  });
});

describe('isFailed', () => {
  it('counts an errored call', () => {
    expect(isFailed(tool('Bash', { isError: true, status: 'complete' }))).toBe(true);
  });
  it('counts an incomplete call, but not a cancelled one', () => {
    expect(isFailed(tool('Bash', { status: 'incomplete', statusReason: 'error' }))).toBe(true);
    expect(isFailed(tool('Bash', { status: 'incomplete', statusReason: 'cancelled' }))).toBe(false);
  });
  it('never counts a call that is still running', () => {
    expect(isFailed(tool('Bash', { status: 'running', isError: true }))).toBe(false);
  });
});

describe('summarizeSteps', () => {
  it('names each kind of step with its count, in the order they happened', () => {
    expect(summarizeSteps([bash(), bash(), bash(), tool('Write'), tool('Write'), tool('Grep')]))
      .toBe('Ran 3 commands, wrote 2 files, searched');
  });

  it('uses singular forms for one', () => {
    expect(summarizeSteps([bash(), tool('Read')])).toBe('Ran 1 command, read 1 file');
  });

  it('counts repeated searches and MCP calls by server', () => {
    expect(summarizeSteps([tool('Grep'), tool('Glob'), tool('mcp__apis__list_apis'), tool('mcp__apis__call')]))
      .toBe('Searched 2 times, called apis 2 times');
  });

  it('tells the install wrapper apart from an ordinary command, from args or the precomputed flag', () => {
    expect(summarizeSteps([bash('.applications/install pip pandas --app x')])).toBe('Installed 1 package');
    expect(summarizeSteps([tool('Bash', { install: true })])).toBe('Installed 1 package');
  });

  it('caps the line and says how much it left out', () => {
    const many = [bash(), tool('Read'), tool('Write'), tool('Edit'), tool('WebFetch'), tool('Agent')];
    expect(summarizeSteps(many)).toBe('Ran 1 command, read 1 file, wrote 1 file, edited 1 file, +2 more');
  });

  it('ignores anything that is not a tool call', () => {
    expect(summarizeSteps([text(), { type: 'reasoning' }])).toBe('');
  });
});

describe('the fold line', () => {
  it('formats durations the way the design shows them', () => {
    expect(formatWorkedFor(38_000)).toBe('38s');
    expect(formatWorkedFor(252_000)).toBe('4m 12s');
    expect(formatWorkedFor(240_000)).toBe('4m');
    expect(formatWorkedFor(3_780_000)).toBe('1h 3m');
  });

  it('reads "Worked for 4m 12s · 26 steps"', () => {
    expect(turnFoldLabel(26, 252_000)).toBe('Worked for 4m 12s · 26 steps');
    expect(turnFoldLabel(1, 5_000)).toBe('Worked for 5s · 1 step');
  });

  it('drops the duration rather than inventing one when it is unknown', () => {
    expect(turnFoldLabel(26, null)).toBe('Worked · 26 steps');
    expect(turnFoldLabel(3, 0)).toBe('Worked · 3 steps');
  });
});
