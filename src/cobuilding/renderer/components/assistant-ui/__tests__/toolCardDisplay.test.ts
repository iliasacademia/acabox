import { getToolCardDisplay } from '../tool-card-display';
import { isEmptyFinishedMessage, isStoppedMessage } from '../turnSteps';

describe('getToolCardDisplay — step rows in plain words', () => {
  it('prefers the model-written description over the raw shell line', () => {
    const d = getToolCardDisplay('Bash', { command: 'awk -F, \'{s+=$3} END {print s}\' data.csv', description: 'Add up the third column' });
    expect(d.name).toBe('command');
    expect(d.args).toBe('Add up the third column');
  });

  it('falls back to the command when there is no description', () => {
    expect(getToolCardDisplay('Bash', { command: 'ls  -la' }).args).toBe('ls -la');
  });

  it('keeps the install wrapper as its own row', () => {
    expect(getToolCardDisplay('Bash', { command: '.applications/install pip pandas' })).toMatchObject({
      name: 'install',
      args: 'pip pandas',
    });
  });

  it('names the rest without Unix or SDK vocabulary', () => {
    expect(getToolCardDisplay('Glob', { pattern: '**/*.csv' }).name).toBe('find files');
    expect(getToolCardDisplay('Grep', { pattern: 'p53' }).name).toBe('search text');
    expect(getToolCardDisplay('WebFetch', { url: 'https://example.org' }).name).toBe('web page');
    expect(getToolCardDisplay('Agent', { description: 'Check refs' }).name).toBe('helper');
    expect(getToolCardDisplay('TodoWrite', {}).name).toBe('checklist');
    expect(getToolCardDisplay('mcp__workspace__get_research_profile', {}).name).toBe('your files');
    expect(getToolCardDisplay('mcp__mini-apps__open_mini_application', { dir_name: 'volcano' }).name).toBe('tool');
  });

  it('humanizes other MCP tools as "server" + spaced tool name', () => {
    expect(getToolCardDisplay('mcp__hex__create_thread', {})).toMatchObject({ name: 'hex', args: 'create thread' });
  });
});

describe('isStoppedMessage', () => {
  it('reads the history flag', () => {
    expect(isStoppedMessage({ type: 'complete' }, { stopped: true })).toBe(true);
  });

  it('reads a live Stop from the cancelled status assistant-ui writes', () => {
    expect(isStoppedMessage({ type: 'incomplete', reason: 'cancelled' }, {})).toBe(true);
  });

  it('is false for a normal finish and for a failure', () => {
    expect(isStoppedMessage({ type: 'complete' }, { workedMs: 4000 })).toBe(false);
    expect(isStoppedMessage({ type: 'incomplete', reason: 'error' }, {})).toBe(false);
    expect(isStoppedMessage(undefined, undefined)).toBe(false);
  });
});

describe('isEmptyFinishedMessage', () => {
  it('hides the shell left behind by a Stop pressed before anything arrived', () => {
    expect(isEmptyFinishedMessage({ type: 'incomplete', reason: 'cancelled' }, 0)).toBe(true);
  });

  it('keeps a running message, a message with parts, and a failed message', () => {
    expect(isEmptyFinishedMessage({ type: 'running' }, 0)).toBe(false);
    expect(isEmptyFinishedMessage({ type: 'complete' }, 2)).toBe(false);
    expect(isEmptyFinishedMessage({ type: 'incomplete', reason: 'error' }, 0)).toBe(false);
  });
});
