import React, { useState, useEffect, useCallback } from 'react';

// ─── Tree data structure ────────────────────────────────────────

interface TreeNode {
  id: string;
  label: string;
  description?: string;
  warning?: string;
  children?: TreeNode[];
}

const STORAGE_TREE: TreeNode[] = [
  {
    id: 'databases',
    label: 'Databases',
    children: [
      {
        id: 'chat-db',
        label: 'Chat Database',
        children: [
          { id: 'chat-sessions', label: 'Chat Sessions & Messages', description: 'All conversations across all workspaces' },
          { id: 'workspace-records', label: 'Workspace Records', description: 'Workspace entries in the database', warning: 'Also deletes .academia/ and .claude/ inside each workspace directory' },
        ],
      },
      {
        id: 'observations-db',
        label: 'Observations Database',
        children: [
          { id: 'browser-activity', label: 'Browser Activity', description: 'Browsing history, page snapshots, dwell time' },
          { id: 'file-activity', label: 'File Activity', description: 'File monitoring sessions, diffs, snapshots' },
        ],
      },
      {
        id: 'scheduling-db',
        label: 'Scheduling Database',
        children: [
          { id: 'scheduled-tasks', label: 'Scheduled Tasks', description: 'Task definitions and run history (e.g., Reactions)' },
          { id: 'task-runs', label: 'Task Run History Only', description: 'Execution history, keeps task definitions' },
        ],
      },
    ],
  },
  {
    id: 'logs',
    label: 'Logs',
    children: [
      { id: 'system-log', label: 'System Log', description: 'cobuilding-system-log.jsonl' },
      { id: 'command-log', label: 'Command Log', description: 'cobuilding-command-log.jsonl' },
      { id: 'app-log', label: 'App Log', description: 'cobuilding.log (electron-log)' },
    ],
  },
  {
    id: 'podman',
    label: 'Podman',
    children: [
      { id: 'podman-binaries', label: 'Podman Binaries', description: 'Downloaded podman, gvproxy, vfkit' },
      { id: 'podman-config-data', label: 'Config & VM Images', description: 'Podman config, container layers, VM disk images' },
      { id: 'podman-vm', label: 'VM State & Sockets', description: 'Machine state, SSH keys, Unix sockets' },
    ],
  },
  { id: 'settings', label: 'Settings', description: 'cobuilding-settings.json (binary mode, image source, etc.)' },
  { id: 'electron-cache', label: 'Electron Cache', description: 'GPU cache, code cache, local/session storage' },
];

// ─── Helpers ────────────────────────────────────────────────────

function getLeafIds(node: TreeNode): string[] {
  if (!node.children) return [node.id];
  return node.children.flatMap(getLeafIds);
}

function getAllLeafIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap(getLeafIds);
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

function getNodeState(node: TreeNode, selected: Set<string>): CheckState {
  if (!node.children) {
    return selected.has(node.id) ? 'checked' : 'unchecked';
  }
  const childStates = node.children.map(c => getNodeState(c, selected));
  if (childStates.every(s => s === 'checked')) return 'checked';
  if (childStates.every(s => s === 'unchecked')) return 'unchecked';
  return 'indeterminate';
}

// ─── Checkbox component ─────────────────────────────────────────

const TriCheckbox: React.FC<{
  state: CheckState;
  onChange: () => void;
  disabled?: boolean;
}> = ({ state, onChange, disabled }) => (
  <span
    className={`storageTree__checkbox storageTree__checkbox--${state}${disabled ? ' storageTree__checkbox--disabled' : ''}`}
    onClick={disabled ? undefined : onChange}
    role="checkbox"
    aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
  >
    {state === 'checked' ? '✓' : state === 'indeterminate' ? '–' : ''}
  </span>
);

// ─── Tree node component ────────────────────────────────────────

const TreeNodeRow: React.FC<{
  node: TreeNode;
  depth: number;
  selected: Set<string>;
  onToggle: (node: TreeNode) => void;
  disabled: boolean;
}> = ({ node, depth, selected, onToggle, disabled }) => {
  const state = getNodeState(node, selected);
  const hasChildren = !!node.children;

  return (
    <>
      <div className="storageTree__row" style={{ paddingLeft: 12 + depth * 20 }}>
        <TriCheckbox state={state} onChange={() => onToggle(node)} disabled={disabled} />
        <span className={`storageTree__label${hasChildren ? ' storageTree__label--group' : ''}`}>
          {node.label}
        </span>
        {node.description && (
          <span className="storageTree__desc">{node.description}</span>
        )}
        {node.warning && state !== 'unchecked' && (
          <span className="storageTree__warning">&#9888; {node.warning}</span>
        )}
      </div>
      {hasChildren && node.children!.map(child => (
        <TreeNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selected={selected}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </>
  );
};

// ─── Main component ─────────────────────────────────────────────

export const StorageDebug: React.FC = () => {
  const [environment, setEnvironment] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<{ cleared: string[]; errors: string[] } | null>(null);

  useEffect(() => {
    window.debugAPI.getStorageInfo().then((data) => {
      setEnvironment(data.environment);
    });
  }, []);

  const toggleNode = useCallback((node: TreeNode) => {
    setSelected(prev => {
      const next = new Set(prev);
      const leafIds = getLeafIds(node);
      const state = getNodeState(node, prev);
      if (state === 'checked') {
        leafIds.forEach(id => next.delete(id));
      } else {
        leafIds.forEach(id => next.add(id));
      }
      return next;
    });
    setResult(null);
  }, []);

  const selectAll = () => {
    setSelected(new Set(getAllLeafIds(STORAGE_TREE)));
    setResult(null);
  };

  const selectNone = () => {
    setSelected(new Set());
    setResult(null);
  };

  const handleClear = async () => {
    if (selected.size === 0) return;

    const items = [...selected];
    const hasWorkspaces = items.includes('workspace-records');
    const msg = hasWorkspaces
      ? `Delete ${items.length} selected item(s)?\n\nThis includes workspace records, which will also delete .academia/ and .claude/ directories inside each workspace.`
      : `Delete ${items.length} selected item(s)?`;

    if (!window.confirm(msg)) return;

    setClearing(true);
    setResult(null);
    try {
      const res = await window.debugAPI.clearSelected(items);
      setResult(res);
      if (res.errors.length === 0) {
        setSelected(new Set());
      }
    } catch (err) {
      setResult({ cleared: [], errors: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Storage</h3>

      <div className="debugSection__infoRow" style={{ marginBottom: 12 }}>
        <span className="debugSection__infoLabel">Environment:</span>
        <code className="debugSection__infoValue">{environment}</code>
      </div>

      <div className="storageTree__actions">
        <button className="debugSection__btnInline" onClick={selectAll} disabled={clearing}>Select All</button>
        <button className="debugSection__btnInline" onClick={selectNone} disabled={clearing}>Select None</button>
      </div>

      <div className="storageTree">
        {STORAGE_TREE.map(node => (
          <TreeNodeRow
            key={node.id}
            node={node}
            depth={0}
            selected={selected}
            onToggle={toggleNode}
            disabled={clearing}
          />
        ))}
      </div>

      <div className="debugSection__actions" style={{ marginTop: 12 }}>
        <button
          className="debugSection__btn debugSection__btn--stop"
          onClick={handleClear}
          disabled={clearing || selected.size === 0}
        >
          {clearing ? 'Clearing...' : `Delete Selected (${selected.size})`}
        </button>
      </div>

      {result && result.cleared.length > 0 && (
        <div className="debugSection__progress">
          Cleared: {result.cleared.join(', ')}
        </div>
      )}
      {result && result.errors.length > 0 && (
        <div className="debugSection__error">
          Errors: {result.errors.join(', ')}
        </div>
      )}
    </div>
  );
};
