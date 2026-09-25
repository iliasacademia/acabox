import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CopyFileButton, copyableText } from '../fileViewers/CopyFileButton';

/**
 * The file view's Copy button: copies the file exactly as it is on disk, and
 * is absent for files that have no text to give.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let writeText: jest.Mock;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  writeText = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.useRealTimers();
});

const button = () => container.querySelector('button');

describe('copyableText', () => {
  it('gives the raw text of text-like files — markdown source, not rendered output', () => {
    const md = '# Title\n\n> **Task:** run it\n';
    expect(copyableText({ type: 'markdown', content: md })).toBe(md);
    expect(copyableText({ type: 'text', content: 'x = 1' })).toBe('x = 1');
    expect(copyableText({ type: 'csv', content: 'a,b\n1,2', delimiter: ',' })).toBe('a,b\n1,2');
    expect(copyableText({ type: 'latex', content: '\\section{A}' })).toBe('\\section{A}');
  });

  it('gives nothing for files with no text, so no dead button is drawn', () => {
    expect(copyableText({ type: 'image', fileUrl: 'local-file:///a.png' })).toBeNull();
    expect(copyableText({ type: 'pdf', fileUrl: 'local-file:///a.pdf' })).toBeNull();
    expect(copyableText({ type: 'spreadsheet', base64: 'AA==', ext: 'xlsx' })).toBeNull();
    expect(copyableText({ error: 'too-large', size: 99_000_000 })).toBeNull();
    expect(copyableText(null)).toBeNull();
  });

  it('an empty file is still copyable text', () => {
    expect(copyableText({ type: 'text', content: '' })).toBe('');
  });
});

describe('<CopyFileButton/>', () => {
  it('renders nothing without text', async () => {
    await act(async () => { root.render(<CopyFileButton text={null} />); });
    expect(button()).toBeNull();
  });

  it('copies the whole text, says so, then goes back to Copy', async () => {
    const long = 'line\n'.repeat(5000);
    await act(async () => { root.render(<CopyFileButton text={long} />); });
    expect(button()!.textContent).toContain('Copy');

    await act(async () => { button()!.click(); });
    expect(writeText).toHaveBeenCalledWith(long);
    expect(button()!.textContent).toContain('Copied');

    await act(async () => { jest.advanceTimersByTime(1600); });
    expect(button()!.textContent).not.toContain('Copied');
  });

  it('says when the clipboard refused, rather than claiming success', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('Document is not focused.')));
    await act(async () => { root.render(<CopyFileButton text="abc" />); });
    await act(async () => { button()!.click(); });
    expect(button()!.textContent).toContain('Couldn’t copy');
  });

  it('a different file starts fresh, not showing the last one’s "Copied"', async () => {
    await act(async () => { root.render(<CopyFileButton text="first" />); });
    await act(async () => { button()!.click(); });
    expect(button()!.textContent).toContain('Copied');
    await act(async () => { root.render(<CopyFileButton text="second" />); });
    expect(button()!.textContent).not.toContain('Copied');
  });
});
