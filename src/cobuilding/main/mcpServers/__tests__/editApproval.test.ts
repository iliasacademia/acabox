/**
 * Tests for the per-edit approval logic in the ms-word MCP server.
 */

describe('edit approval mode', () => {
  // Simulate the approval logic from the find_and_replace tool
  function checkApproval(
    editApprovalMode: 'ask' | 'always',
    args: { approved?: boolean; always_allow?: boolean },
  ): { shouldExecute: boolean; newMode: 'ask' | 'always' } {
    let mode = editApprovalMode;

    if (args.always_allow) {
      mode = 'always';
    }

    if (mode === 'ask' && !args.approved) {
      return { shouldExecute: false, newMode: mode };
    }

    return { shouldExecute: true, newMode: mode };
  }

  it('blocks unapproved edits in ask mode', () => {
    const result = checkApproval('ask', {});
    expect(result.shouldExecute).toBe(false);
    expect(result.newMode).toBe('ask');
  });

  it('allows approved edits in ask mode', () => {
    const result = checkApproval('ask', { approved: true });
    expect(result.shouldExecute).toBe(true);
    expect(result.newMode).toBe('ask');
  });

  it('allows all edits in always mode', () => {
    const result = checkApproval('always', {});
    expect(result.shouldExecute).toBe(true);
    expect(result.newMode).toBe('always');
  });

  it('switches to always mode when always_allow is set', () => {
    const result = checkApproval('ask', { always_allow: true });
    expect(result.shouldExecute).toBe(true);
    expect(result.newMode).toBe('always');
  });

  it('always_allow with approved also works', () => {
    const result = checkApproval('ask', { approved: true, always_allow: true });
    expect(result.shouldExecute).toBe(true);
    expect(result.newMode).toBe('always');
  });

  it('stays in always mode once set', () => {
    // First call switches to always
    const first = checkApproval('ask', { always_allow: true });
    expect(first.newMode).toBe('always');

    // Subsequent calls without any flags still execute
    const second = checkApproval(first.newMode, {});
    expect(second.shouldExecute).toBe(true);
    expect(second.newMode).toBe('always');
  });
});

describe('approval message formatting', () => {
  function formatApprovalMessage(searchText: string, replacementText: string): string {
    return `Acabox wants to replace "${searchText.substring(0, 60)}${searchText.length > 60 ? '...' : ''}" with "${replacementText.substring(0, 60)}${replacementText.length > 60 ? '...' : ''}"`;
  }

  it('formats short text without truncation', () => {
    const msg = formatApprovalMessage('hello', 'world');
    expect(msg).toBe('Acabox wants to replace "hello" with "world"');
  });

  it('truncates long text with ellipsis', () => {
    const longText = 'a'.repeat(100);
    const msg = formatApprovalMessage(longText, 'short');
    expect(msg).toContain('...');
    expect(msg).toContain('a'.repeat(60));
    expect(msg).not.toContain('a'.repeat(61));
  });

  it('uses Acabox branding', () => {
    const msg = formatApprovalMessage('x', 'y');
    expect(msg).toContain('Acabox');
    expect(msg).not.toContain('Claude');
  });
});
