import type { AgentSession } from './agentSession';

const sessions = new Map<string, AgentSession>();

export function registerSession(id: string, session: AgentSession): void {
  sessions.set(id, session);
}

export function unregisterSession(id: string): void {
  sessions.delete(id);
}

export function getRegisteredSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

export function destroyAllSessions(): void {
  for (const session of sessions.values()) {
    session.destroy();
  }
  sessions.clear();
}
