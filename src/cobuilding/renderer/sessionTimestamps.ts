/** Keeps session created_at keyed by remote id; @assistant-ui remote list metadata does not carry it. */

/**
 * Cobuilding SQLite uses `strftime(..., 'now')`, which is UTC but omits `Z`.
 * `new Date('2026-04-06T19:33:00')` is parsed as *local* wall time, so the instant is wrong.
 * Values that already include `Z` or a numeric offset are left unchanged.
 */
export function dateFromSessionStoredAt(stored: string): Date {
  const t = stored.trim();
  if (!t) return new Date(NaN);
  if (/[zZ]$/.test(t) || /[+-]\d{2}:\d{2}$/.test(t)) {
    return new Date(t);
  }
  return new Date(`${t}Z`);
}

const createdAtByRemoteId = new Map<string, string>();
const documentPathByRemoteId = new Map<string, string | null>();

export function getSessionCreatedAt(remoteId: string | undefined): string | undefined {
  if (!remoteId) return undefined;
  return createdAtByRemoteId.get(remoteId);
}

export function getSessionDocumentPath(remoteId: string | undefined): string | null | undefined {
  if (!remoteId) return undefined;
  return documentPathByRemoteId.get(remoteId);
}

export function replaceSessionTimestampsFromList(
  sessions: readonly { id: string; created_at: string; document_path?: string | null }[],
): void {
  createdAtByRemoteId.clear();
  documentPathByRemoteId.clear();
  for (const s of sessions) {
    createdAtByRemoteId.set(s.id, s.created_at);
    documentPathByRemoteId.set(s.id, s.document_path ?? null);
  }
}

export function setSessionCreatedAt(remoteId: string, createdAt: string): void {
  createdAtByRemoteId.set(remoteId, createdAt);
}

export function setSessionDocumentPath(remoteId: string, documentPath: string | null): void {
  documentPathByRemoteId.set(remoteId, documentPath);
}
