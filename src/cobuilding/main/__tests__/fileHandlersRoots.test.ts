import { isAllowedRoot } from '../fileHandlers';

describe('isAllowedRoot', () => {
  const dirs = ['/ws', '/Users/x/MyResearch'];

  it('is true for the workspace and for a shared-folder root', () => {
    expect(isAllowedRoot('/ws', dirs)).toBe(true);
    expect(isAllowedRoot('/Users/x/MyResearch', dirs)).toBe(true);
  });

  it('is false for anything inside a root', () => {
    expect(isAllowedRoot('/ws/a.csv', dirs)).toBe(false);
    expect(isAllowedRoot('/Users/x/MyResearch/sub', dirs)).toBe(false);
  });
});
