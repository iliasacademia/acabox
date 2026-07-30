import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { KnowledgePage } from '../knowledge/KnowledgePage';
import type { SkillDescriptor } from '../../../shared/skills';

/**
 * These cases exist for one reason: the Knowledge page's whole claim is that
 * everything on it is real. A regression here is not a cosmetic one — it is the
 * page telling the user something about their system that is not true.
 *
 * So the assertions are mostly NEGATIVE. "Unknown" must never appear, a custom
 * skill must carry no MODIFIED chip either way, a memory with no frontmatter
 * must carry no type chip, and no "recalled" language may exist anywhere in the
 * rendered document.
 */

const mockSetText = jest.fn();
const mockSend = jest.fn();

jest.mock('@assistant-ui/react', () => ({
  useComposerRuntime: () => ({ setText: mockSetText, send: mockSend }),
}));

// react-markdown and remark-gfm ship as ESM. They reach this suite only through
// the detail modal's <MarkdownView>, which no case here opens, so stubbing them
// is cheaper and less brittle than widening transformIgnorePatterns to pull in
// their whole unified/remark graph.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => children,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

// React 19 warns on every state update outside act() without this.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function skill(over: Partial<SkillDescriptor> & { id: string }): SkillDescriptor {
  return {
    origin: 'builtin',
    enabled: true,
    storePath: `/store/${over.id}`,
    frontmatterOk: true,
    skillMdBytes: 1024,
    fileCount: 1,
    execCount: 0,
    ...over,
  };
}

function memory(over: Partial<MemoryFileInfo> & { file: string }): MemoryFileInfo {
  return {
    academiaPath: `agent-memory/${over.file}`,
    bytes: 100,
    changedAt: Date.now() - 3 * 60 * 60 * 1000,
    originChat: null,
    indexed: true,
    isIndex: false,
    frontmatterOk: true,
    ...over,
  };
}

let skills: SkillDescriptor[] = [];
let memories: MemoryFileInfo[] = [];
let reviews: KnowledgeReviewItem[] = [];

beforeAll(() => {
  (window as any).skillsAPI = {
    list: jest.fn(async () => skills),
    read: jest.fn(async () => ({ ok: true, content: '' })),
    write: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
    setEnabled: jest.fn(async () => ({ ok: true, pushed: true })),
    revertFile: jest.fn(),
    revert: jest.fn(),
    dismissUpdate: jest.fn(),
    summarizeRestore: jest.fn(),
    restoreAll: jest.fn(),
    reveal: jest.fn(),
  };
  (window as any).knowledgeAPI = {
    ledger: jest.fn(),
    supersede: jest.fn(),
    listReviews: jest.fn(async () => reviews),
    dismissReview: jest.fn(async () => ({ ok: true })),
    memories: jest.fn(async () => ({ dir: '/ws/.academia/agent-memory', files: memories })),
  };
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
  skills = [];
  memories = [];
  reviews = [];
});

afterAll(() => {
  delete (window as any).skillsAPI;
  delete (window as any).knowledgeAPI;
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <KnowledgePage onSwitchToChat={jest.fn()} onOpenChat={jest.fn()} onOpenSettings={jest.fn()} />,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('KnowledgePage', () => {
  it('renders a broken-frontmatter skill by its directory name and says what it costs', async () => {
    skills = [skill({ id: 'geo-database', frontmatterOk: false, frontmatterError: 'bad indentation' })];
    await render();
    expect(container.textContent).toContain('geo-database');
    expect(container.textContent).toContain('BROKEN');
    // The point of the row is that the CLI's drop is silent. Saying so is the
    // feature; a bare badge would leave the user no better off.
    expect(container.textContent).toContain('Claude will not see this skill at all');
    expect(container.textContent).toContain('bad indentation');
  });

  it('never renders a MODIFIED chip for a custom skill, in either direction', async () => {
    // `modified` is undefined for custom skills — there is no shipped copy, so
    // both "MODIFIED" and "unmodified" would be claims the store cannot make.
    skills = [
      skill({ id: 'mine', origin: 'custom', modified: undefined }),
      skill({ id: 'shipped', origin: 'builtin', modified: true }),
    ];
    await render();
    const rows = container.querySelectorAll('.connectorRow');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('MINE');
    expect(rows[0]!.textContent).not.toContain('MODIFIED');
    expect(rows[1]!.textContent).toContain('MODIFIED');
  });

  it('renders no fabricated status anywhere — no "Unknown", no "recalled"', async () => {
    skills = [skill({ id: 'acabox', description: 'How Acabox itself works.' })];
    memories = [memory({ file: 'about_you.md' })];
    await render();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toMatch(/recall/i);
  });

  it('renders a memory with no frontmatter by filename, with no type chip', async () => {
    // about_you.md and working_on.md genuinely declare nothing. Inventing a
    // type for them is exactly the fabrication this page exists to avoid.
    memories = [
      memory({ file: 'about_you.md', indexed: false }),
      memory({ file: 'project_x.md', declaredName: 'Warehouse traps', type: 'project', description: 'Six of them.' }),
    ];
    await render();
    const rows = container.querySelectorAll('.connectorRow');
    expect(rows[0]!.textContent).toContain('about_you.md');
    expect(rows[0]!.textContent).toContain('UNLINKED');
    expect(rows[0]!.textContent).not.toContain('PROJECT');
    expect(rows[1]!.textContent).toContain('Warehouse traps');
    expect(rows[1]!.textContent).toContain('PROJECT');
    expect(rows[1]!.textContent).not.toContain('UNLINKED');
  });

  it('omits both empty sections rather than showing empty headings', async () => {
    await render();
    expect(container.textContent).not.toContain('Needs attention');
    expect(container.textContent).not.toContain('What Claude has learned');
    // Skills is always present — it is the page's subject, and "no skills in
    // the store" is itself a finding worth showing.
    expect(container.textContent).toContain('No skills in the store.');
  });

  it('shows a Needs-attention row for a connector turn that skipped the ledger', async () => {
    reviews = [{
      id: 'r1',
      kind: 'connector-without-ledger',
      sessionId: 'chat-1',
      chatTitle: 'Weekly active users',
      connectors: ['hex'],
      at: Date.now() - 2 * 60 * 60 * 1000,
    }];
    await render();
    expect(container.textContent).toContain('Needs attention');
    expect(container.textContent).toContain('This chat queried hex without consulting the ledger');
    expect(container.textContent).toContain('Weekly active users');
    expect(container.textContent).toContain('2h ago');
  });

  it('counts MEMORY.md as the index, not as a memory', async () => {
    memories = [
      memory({ file: 'MEMORY.md', isIndex: true }),
      memory({ file: 'project_x.md' }),
    ];
    await render();
    // One real memory, plus the index row rendered but not counted.
    expect(container.querySelector('.pageShell__stats')!.textContent).toContain('1 MEMORY');
    expect(container.textContent).toContain('INDEX');
  });

  it('renders no roster-budget meter, because the measured figure is not plumbed', async () => {
    // Computing it locally would omit the user's own ~/.claude/skills, which
    // the CLI also discovers and which spends the same budget. A bar missing a
    // third of the load is worse than no bar. If this ever fails, the meter has
    // been added — make sure it came from getContextUsage().
    skills = [skill({ id: 'acabox' })];
    await render();
    expect(container.textContent).not.toMatch(/roster budget/i);
    expect(container.textContent).not.toMatch(/\d+\s*\/\s*\d+ chars/);
  });
});
