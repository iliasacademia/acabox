/**
 * The "first message after a gap is swallowed" bug, observed eight times in
 * production between 2026-09-17 and 2026-09-21. Every case had the same
 * transcript shape: the CLI queued itself a `task_notification` for a
 * background command Acabox had orphaned, dequeued that as a turn's prompt
 * 9–18 ms before the user's text landed, made no API call, and ended the turn
 *
 *     {"subtype":"success","result":"","is_error":false}
 *
 * — then, ~10 ms later, started a turn for the user's text on its own. The
 * host read the empty result as turn-complete and the registry killed the CLI
 * 28 ms into that real turn. Retyping worked every time because it was a fresh
 * session. The fix is to not end the turn on that result.
 *
 * Three things are pinned here against the real code, not a mock:
 *
 *  1. The fingerprint fires on exactly that shape and on nothing adjacent to
 *     it. `/compact` also ends in an empty success — and IS an API call, so
 *     waiting on or re-sending after one would be wrong. A turn that produced
 *     output (a full message OR a streamed delta), or errored, or whose
 *     background task ended by itself, must not match.
 *  2. The signal counter only counts what the predicate means by it: the
 *     `stopped` status, not `completed`/`failed`; assistant messages and
 *     stream events, not the system chatter around them.
 *  3. The ladder is wait → redeliver → surface, each step at most once. Wait
 *     comes first because it is free: the CLI is about to run the message
 *     itself. Redelivery costs an API call and is the fallback, not the plan.
 *
 * `better-sqlite3` is built for Electron's ABI, so the live behaviour — the
 * turn staying open, the CLI's follow-up answering, one turn-complete — is
 * verified over CDP against `npm start`, not here.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-swallowed-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { isSwallowedResumeTurn, noteSwallowSignals, swallowedResultAction } from '../agentSession';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** Exactly what row 6248 of the production DB held. */
const EMPTY_SUCCESS = { type: 'result', subtype: 'success', result: '', is_error: false } as any;

const turn = (assistantMessages: number, stoppedTaskNotifications: number, streamEvents = 0) =>
  ({ assistantMessages, streamEvents, stoppedTaskNotifications });

describe('isSwallowedResumeTurn', () => {
  it('fires on the production shape: empty success, no model output, a stopped background task', () => {
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, turn(0, 1))).toBe(true);
  });

  it('treats a whitespace-only result as empty', () => {
    expect(isSwallowedResumeTurn({ ...EMPTY_SUCCESS, result: '  \n' }, turn(0, 1))).toBe(true);
  });

  it('does NOT fire on /compact, which also ends in an empty success', () => {
    // No task was stopped — the emptiness is the compaction's own. Acting on
    // it would run a second compaction, a real API call.
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, turn(0, 0))).toBe(false);
  });

  it('does NOT fire when the model produced anything at all', () => {
    // Even one assistant message means the model saw the turn. Whatever it
    // chose to say (or not say) is its answer, not a swallowed message.
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, turn(1, 1))).toBe(false);
  });

  it('does NOT fire when a streamed delta arrived, even with no full assistant message', () => {
    // includePartialMessages is on, so `message_start` precedes any assistant
    // message. A delta is proof the API was called; the empty result then
    // belongs to the model, not to the queue race.
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, turn(0, 1, 1))).toBe(false);
  });

  it('does NOT fire on a non-empty result', () => {
    expect(isSwallowedResumeTurn({ ...EMPTY_SUCCESS, result: 'Done.' }, turn(0, 1))).toBe(false);
  });

  it('does NOT fire on an error result, whatever the text', () => {
    // An error is an error; the overflow and auth paths own those.
    expect(isSwallowedResumeTurn({ ...EMPTY_SUCCESS, is_error: true }, turn(0, 1))).toBe(false);
    expect(isSwallowedResumeTurn({ type: 'result', subtype: 'error_during_execution', is_error: true } as any, turn(0, 1))).toBe(false);
  });

  it('ignores everything that is not a result message', () => {
    expect(isSwallowedResumeTurn({ type: 'assistant' } as any, turn(0, 1))).toBe(false);
    expect(isSwallowedResumeTurn({ type: 'system', subtype: 'task_notification', status: 'stopped' } as any, turn(0, 1))).toBe(false);
  });
});

describe('noteSwallowSignals', () => {
  it('counts assistant messages, stream events and stopped task notifications — nothing else', () => {
    const t = turn(0, 0);
    const stream: any[] = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'task_notification', status: 'stopped', task_id: 'b1rdiaqs8' },
      { type: 'system', subtype: 'mcp_status' },
      { type: 'system', subtype: 'status' },
      { type: 'user', message: { role: 'user', content: [] } },
      { type: 'result', subtype: 'success', result: '' },
    ];
    for (const m of stream) noteSwallowSignals(m, t);
    expect(t).toEqual({ assistantMessages: 0, streamEvents: 0, stoppedTaskNotifications: 1 });

    noteSwallowSignals({ type: 'stream_event', event: { type: 'message_start' } } as any, t);
    noteSwallowSignals({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as any, t);
    noteSwallowSignals({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } } as any, t);
    expect(t).toEqual({ assistantMessages: 2, streamEvents: 1, stoppedTaskNotifications: 1 });
  });

  it('does not count a background task that completed or failed on its own', () => {
    // That is the ordinary lifecycle of a background command and must not make
    // the next empty result look swallowed.
    const t = turn(0, 0);
    noteSwallowSignals({ type: 'system', subtype: 'task_notification', status: 'completed' } as any, t);
    noteSwallowSignals({ type: 'system', subtype: 'task_notification', status: 'failed' } as any, t);
    expect(t.stoppedTaskNotifications).toBe(0);
  });

  it('feeds the predicate end to end on the production sequence', () => {
    // The stream the host saw at 09:28:42–45 on 2026-09-21, in order.
    const t = turn(0, 0);
    noteSwallowSignals({ type: 'system', subtype: 'task_notification', status: 'stopped' } as any, t);
    noteSwallowSignals({ type: 'system', subtype: 'init' } as any, t);
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, t)).toBe(true);

    // ...and the CLI's own follow-up turn, which carried output. Its result is
    // the real end of the turn even though `stoppedTaskNotifications` is still 1.
    noteSwallowSignals({ type: 'system', subtype: 'init' } as any, t);
    noteSwallowSignals({ type: 'stream_event', event: { type: 'message_start' } } as any, t);
    noteSwallowSignals({ type: 'assistant', message: { content: [] } } as any, t);
    expect(isSwallowedResumeTurn({ ...EMPTY_SUCCESS, result: 'SECOND' }, t)).toBe(false);
    expect(isSwallowedResumeTurn(EMPTY_SUCCESS, t)).toBe(false);
  });
});

describe('swallowedResultAction', () => {
  it('waits first — the free step, because the CLI runs the message itself', () => {
    expect(swallowedResultAction({ waitedForFollowUp: false, redelivered: false })).toBe('wait');
  });

  it('redelivers once the wait has been used', () => {
    expect(swallowedResultAction({ waitedForFollowUp: true, redelivered: false })).toBe('redeliver');
  });

  it('surfaces after the redelivery has been used too — never a third attempt', () => {
    expect(swallowedResultAction({ waitedForFollowUp: true, redelivered: true })).toBe('surface');
  });

  it('never redelivers without having waited', () => {
    // The ladder is ordered; a session that somehow marked redelivered without
    // waiting must still not loop back to a wait or a second redelivery.
    expect(swallowedResultAction({ waitedForFollowUp: false, redelivered: true })).toBe('wait');
  });
});
