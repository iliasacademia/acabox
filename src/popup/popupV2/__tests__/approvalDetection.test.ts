/**
 * Tests for approval prompt detection logic.
 * Validates that the pattern matching works regardless of markdown rendering format.
 */

// Mirror the extractAllText and isApprovalContent logic from OverlayThread
function extractAllText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractAllText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractAllText(node.props.children);
  }
  return '';
}

function isApprovalContent(node: any): boolean {
  const text = extractAllText(node);
  return /allow once/i.test(text) && /always allow/i.test(text) && /deny/i.test(text);
}

describe('extractAllText', () => {
  it('extracts from plain string', () => {
    expect(extractAllText('hello')).toBe('hello');
  });

  it('extracts from number', () => {
    expect(extractAllText(42)).toBe('42');
  });

  it('extracts from null/undefined', () => {
    expect(extractAllText(null)).toBe('');
    expect(extractAllText(undefined)).toBe('');
  });

  it('extracts from array of strings', () => {
    expect(extractAllText(['hello', ' ', 'world'])).toBe('hello world');
  });

  it('extracts from nested React-like element', () => {
    // Simulates: <strong>Allow once</strong>
    const node = { props: { children: 'Allow once' } };
    expect(extractAllText(node)).toBe('Allow once');
  });

  it('extracts from deeply nested elements', () => {
    // Simulates: <li><strong><em>Allow once</em></strong> — apply this edit</li>
    const node = {
      props: {
        children: [
          { props: { children: { props: { children: 'Allow once' } } } },
          ' — apply this edit',
        ],
      },
    };
    expect(extractAllText(node)).toBe('Allow once — apply this edit');
  });

  it('extracts from mixed text and elements', () => {
    // Simulates: "Choose: " + <strong>Allow once</strong> + " / " + <strong>Always allow</strong> + " / " + <strong>Deny</strong>
    const children = [
      'Choose: ',
      { props: { children: 'Allow once' } },
      ' / ',
      { props: { children: 'Always allow' } },
      ' / ',
      { props: { children: 'Deny' } },
    ];
    expect(extractAllText(children)).toBe('Choose: Allow once / Always allow / Deny');
  });

  it('extracts from ul > li structure', () => {
    // Simulates: <ul><li><strong>Allow once</strong> — apply</li><li><strong>Always allow</strong> — auto</li><li><strong>Deny</strong> — skip</li></ul>
    const node = {
      props: {
        children: [
          { props: { children: [{ props: { children: 'Allow once' } }, ' — apply this edit'] } },
          { props: { children: [{ props: { children: 'Always allow' } }, ' — apply and auto-approve'] } },
          { props: { children: [{ props: { children: 'Deny' } }, ' — skip this edit'] } },
        ],
      },
    };
    expect(extractAllText(node)).toContain('Allow once');
    expect(extractAllText(node)).toContain('Always allow');
    expect(extractAllText(node)).toContain('Deny');
  });
});

describe('isApprovalContent', () => {
  it('detects paragraph format: "Choose: Allow once / Always allow / Deny"', () => {
    expect(isApprovalContent('Choose: Allow once / Always allow / Deny')).toBe(true);
  });

  it('detects without "Choose:" prefix', () => {
    expect(isApprovalContent('Allow once / Always allow / Deny?')).toBe(true);
  });

  it('detects with bold markdown rendered as nested elements', () => {
    const children = [
      'Please choose: ',
      { props: { children: 'Allow once' } },
      ' / ',
      { props: { children: 'Always allow' } },
      ' / ',
      { props: { children: 'Deny' } },
    ];
    expect(isApprovalContent(children)).toBe(true);
  });

  it('detects bullet list format', () => {
    const ulChildren = {
      props: {
        children: [
          { props: { children: [{ props: { children: 'Allow once' } }, ' — apply this edit'] } },
          { props: { children: [{ props: { children: 'Always allow' } }, ' — auto-approve subsequent'] } },
          { props: { children: [{ props: { children: 'Deny' } }, ' — skip this edit'] } },
        ],
      },
    };
    expect(isApprovalContent(ulChildren)).toBe(true);
  });

  it('detects deeply nested elements (strong > em)', () => {
    const children = [
      { props: { children: { props: { children: 'Allow once' } } } },
      ' or ',
      { props: { children: { props: { children: 'Always allow' } } } },
      ' or ',
      { props: { children: { props: { children: 'Deny' } } } },
    ];
    expect(isApprovalContent(children)).toBe(true);
  });

  it('detects case-insensitive', () => {
    expect(isApprovalContent('ALLOW ONCE / ALWAYS ALLOW / DENY')).toBe(true);
    expect(isApprovalContent('allow once, always allow, deny')).toBe(true);
  });

  it('does not match when missing a choice', () => {
    expect(isApprovalContent('Allow once / Deny')).toBe(false);
    expect(isApprovalContent('Always allow / Deny')).toBe(false);
    expect(isApprovalContent('Allow once / Always allow')).toBe(false);
  });

  it('does not match regular text', () => {
    expect(isApprovalContent('The results show a significant improvement')).toBe(false);
    expect(isApprovalContent('Please review the changes above')).toBe(false);
  });

  it('does not match partial keywords', () => {
    expect(isApprovalContent('Allow the process once and deny later')).toBe(false);
  });

  it('matches with extra text around choices', () => {
    expect(isApprovalContent(
      'Here is the proposed edit. Please choose: Allow once to apply, Always allow for all edits, or Deny to skip.'
    )).toBe(true);
  });

  it('handles null/undefined children', () => {
    expect(isApprovalContent(null)).toBe(false);
    expect(isApprovalContent(undefined)).toBe(false);
  });

  it('handles empty string', () => {
    expect(isApprovalContent('')).toBe(false);
  });
});
