import { chromeHealth } from '../chromeHealth';

describe('chromeHealth', () => {
  it('is starting until the agent process exists', () => {
    expect(chromeHealth({ agentAlive: false, gaveUp: false })).toBe('starting');
  });
  it('is ready when the agent is alive', () => {
    expect(chromeHealth({ agentAlive: true, gaveUp: false })).toBe('ready');
  });
  it('is offline once the supervisor gave up, whatever else is reported', () => {
    expect(chromeHealth({ agentAlive: false, gaveUp: true })).toBe('offline');
    expect(chromeHealth({ agentAlive: true, gaveUp: true })).toBe('offline');
  });
});
