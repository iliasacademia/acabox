/**
 * Byte-count formatting for the sharing UI (ticket U3). Several components
 * already define a private `formatBytes` (ToolsPage.tsx, the knowledge
 * components) with the same decimal (1000-based) shape but none is exported,
 * so there was nothing to import — this is the first shared copy rather than
 * a fourth private one. Mirrors `ToolsPage.tsx`'s version exactly: B / KB /
 * MB / GB, one decimal place under 10 units, whole numbers above.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}
