export type TabKind = 'file' | 'notebook' | 'miniapp' | 'debug';

export type TabData =
  | { kind: 'file'; filePath: string }
  | { kind: 'notebook'; filePath: string }
  | { kind: 'miniapp'; dirName: string }
  | { kind: 'debug' };

export interface TabDescriptor {
  /** Stable unique ID, e.g. "file::/path/to/file.txt" */
  id: string;
  kind: TabKind;
  /** Display label shown on the tab */
  label: string;
  /** false = preview tab (italic, replaceable by next preview) */
  pinned: boolean;
  data: TabData;
}
