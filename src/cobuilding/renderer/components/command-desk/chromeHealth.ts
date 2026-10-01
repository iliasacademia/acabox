/** READY only when the agent process is actually alive; OFFLINE once the supervisor gave up. */
export function chromeHealth(s: { agentAlive: boolean; gaveUp: boolean }): 'starting' | 'ready' | 'offline' {
  if (s.gaveUp) return 'offline';
  return s.agentAlive ? 'ready' : 'starting';
}
