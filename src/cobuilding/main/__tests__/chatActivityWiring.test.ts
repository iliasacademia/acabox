import * as fs from 'fs';
import * as path from 'path';

/**
 * `main/chatActivity.ts` only knows what `agentSession.ts` tells it, so every
 * place a turn starts or stops must announce it. A future write to
 * `turnInProgress` that forgets would leave a chat pulsing "working" forever
 * (a missed end) or never flagging its reply unread (a missed start) — with
 * no error anywhere.
 *
 * Asserted against the source because driving a real turn needs a live agent
 * server. The pairing is checked per write, not by counting, so moving one
 * call away from its write fails too.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'agentSession.ts'), 'utf8');
const lines = SRC.split('\n');

/** The few lines after `index`, where the announcement must sit. */
function after(index: number, span = 3): string {
  return lines.slice(index + 1, index + 1 + span).join('\n');
}

describe('agentSession announces every turn transition', () => {
  const starts = lines.flatMap((l, i) => (/turnState\.turnInProgress = true;/.test(l) ? [i] : []));
  const ends = lines.flatMap((l, i) => (/turnState\.turnInProgress = false;/.test(l) ? [i] : []));

  it('finds the writes it is guarding (the test is not vacuous)', () => {
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(2);
  });

  it('every turn start is announced', () => {
    for (const i of starts) expect(after(i)).toMatch(/noteTurnStarted\(sessionId\)/);
  });

  it('every turn end is announced', () => {
    for (const i of ends) expect(after(i)).toMatch(/noteTurnEnded\(sessionId\)/);
  });

  it('an error ends the turn for anyone watching', () => {
    const body = SRC.slice(SRC.indexOf('function emitError('), SRC.indexOf('function emitError(') + 600);
    expect(body).toMatch(/noteTurnEnded\(sessionId\)/);
  });

  it('a session destroyed mid-turn does not stay "working"', () => {
    const at = SRC.indexOf('    destroy() {');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at, at + 500)).toMatch(/noteTurnEnded\(sessionId\)/);
  });
});
