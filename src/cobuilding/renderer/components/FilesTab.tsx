import React, { useCallback, useEffect, useRef, useState, type FC } from 'react';
import type { WorkspaceDirectory } from '../../shared/types';
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FilePlusIcon,
  FolderPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  TrashIcon,
  FileTextIcon,
} from 'lucide-react';
import DirectoryPermBadge from './DirectoryPermBadge';
import { ensureAccessibilityPermission } from '../utils/ensureAccessibilityPermission';

const INTERNAL_DRAG_TYPE = 'application/x-filetree-path';

/** Uniform indent: same extra offset for each nesting level (depth 1 = first level under workspace). */
const FILE_TREE_INDENT_BASE = 4;
const FILE_TREE_INDENT_STEP = 12;

function fileTreeRowPaddingLeft(depth: number): number {
  return FILE_TREE_INDENT_BASE + depth * FILE_TREE_INDENT_STEP;
}

/** Hide Office lock files (`~$Manuscript.docx`) created while a doc is open in Word. */
function isHiddenWorkspaceEntry(name: string): boolean {
  return name.startsWith('~$');
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  loaded?: boolean;
  driveFileId?: string;
  driveMimeType?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

type FileTagType = 'manuscript' | 'grant' | 'presentation' | 'reference';

const FILE_TAG_LABEL: Record<FileTagType, string> = {
  manuscript: 'MANUSCRIPT',
  grant: 'GRANT',
  presentation: 'SLIDES',
  reference: 'REFERENCE',
};

interface FilesTabProps {
  workspacePath: string;
  userDirectories?: WorkspaceDirectory[];
  onSelectFile: (path: string) => void;
  onFileCount?: (count: number) => void;
  onDirectoriesChanged?: (dirs: WorkspaceDirectory[]) => void;
}

export const FilesTab: FC<FilesTabProps> = ({ workspacePath, userDirectories, onSelectFile, onFileCount, onDirectoriesChanged }) => {
  const workspaceName = workspacePath.split('/').pop() ?? workspacePath;
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([]);
  const [rootExpanded, setRootExpanded] = useState(true);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [copyProgress, setCopyProgress] = useState<{ copied: number; total: number; currentName: string | null } | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{ dirPath: string; type: 'file' | 'folder' } | null>(null);
  const [fileTagMap, setFileTagMap] = useState<Map<string, FileTagType>>(new Map());
  const [localDirs, setLocalDirs] = useState<WorkspaceDirectory[]>(userDirectories ?? []);
  const [togglingDirId, setTogglingDirId] = useState<string | null>(null);

  useEffect(() => {
    setLocalDirs(userDirectories ?? []);
  }, [userDirectories]);

  const handleTogglePermission = async (dirId: string, currentlyReadOnly: boolean) => {
    if (togglingDirId) return;
    setTogglingDirId(dirId);
    const snapshot = localDirs;
    const optimistic = snapshot.map(d =>
      d.id === dirId ? { ...d, read_only: !currentlyReadOnly } : d
    );
    setLocalDirs(optimistic);
    try {
      const updated = await window.workspacesAPI.updateDirectoryPermission(dirId, !currentlyReadOnly);
      const confirmed = optimistic.map(d => d.id === dirId ? updated : d);
      setLocalDirs(confirmed);
      onDirectoriesChanged?.(confirmed);
    } catch {
      setLocalDirs(snapshot);
    } finally {
      setTogglingDirId(null);
    }
  };

  const resolveRelPath = useCallback((filePath: string): string => {
    if (filePath.startsWith(workspacePath + '/')) return filePath.slice(workspacePath.length + 1);
    let bestLen = 0;
    let bestSlice = filePath;
    for (const ud of (userDirectories ?? [])) {
      if (filePath.startsWith(ud.directory_path + '/') && ud.directory_path.length > bestLen) {
        bestLen = ud.directory_path.length;
        bestSlice = filePath.slice(ud.directory_path.length + 1);
      }
    }
    return bestSlice;
  }, [workspacePath, userDirectories]);

  useEffect(() => {
    window.scannedFilesAPI.getAll().then((files) => {
      console.log('[FilesTab] scanned files from DB:', files.length, files.slice(0, 5));
      const map = new Map<string, FileTagType>();
      for (const f of files) map.set(f.file_path, f.file_type as FileTagType);
      setFileTagMap(map);
    }).catch((err) => { console.error('[FilesTab] scannedFilesAPI.getAll failed:', err); });
  }, []);

  // Prevent Electron's default drag-and-drop behavior (navigating to the file)
  useEffect(() => {
    const preventNav = (e: DragEvent) => e.preventDefault();
    document.addEventListener('dragover', preventNav);
    document.addEventListener('drop', preventNav);
    return () => {
      document.removeEventListener('dragover', preventNav);
      document.removeEventListener('drop', preventNav);
    };
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [contextMenu]);

  useEffect(() => {
    return window.filesAPI.onCopyProgress((progress) => {
      setCopyProgress(progress.currentName === null ? null : progress);
    });
  }, []);


  const countFilesFromEntries = useCallback(async (entries: { name: string; path: string; isDirectory: boolean }[]): Promise<number> => {
    const visible = entries.filter((e) => !isHiddenWorkspaceEntry(e.name));
    let fileCount = visible.filter((e) => !e.isDirectory).length;
    const dirCounts = await Promise.all(
      visible.filter((e) => e.isDirectory).map(async (e) => {
        try {
          const children = await window.filesAPI.readDirectory(e.path);
          return countFilesFromEntries(children);
        } catch {
          return 0;
        }
      }),
    );
    for (const c of dirCounts) fileCount += c;
    return fileCount;
  }, []);

  const loadRoot = useCallback(async () => {
    let entries: { name: string; path: string; isDirectory: boolean }[];
    try {
      const userDirNames = new Set((userDirectories ?? []).map(ud => ud.directory_path.split('/').pop()));
      entries = (await window.filesAPI.readDirectory(workspacePath))
        .filter((e) => !isHiddenWorkspaceEntry(e.name) && !userDirNames.has(e.name) && e.name !== 'google-drive');
    } catch {
      return;
    }
    const nodes = entries.map((e) => ({
      name: e.name,
      path: e.path,
      isDirectory: e.isDirectory,
      children: e.isDirectory ? [] : undefined,
    }));
    setRootChildren(nodes);
    setRootLoaded(true);
    setRootExpanded(true);
    if (onFileCount) {
      const dirs = userDirectories ?? [];
      Promise.all([
        countFilesFromEntries(entries),
        ...dirs.map(async (ud) => {
          try {
            const udEntries = (await window.filesAPI.readDirectory(ud.directory_path))
              .filter((e) => !isHiddenWorkspaceEntry(e.name));
            return countFilesFromEntries(udEntries);
          } catch {
            return 0;
          }
        }),
      ]).then((counts) => onFileCount(counts.reduce((a, b) => a + b, 0)));
    }
  }, [workspacePath, userDirectories, onFileCount, countFilesFromEntries]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const loadChildren = useCallback(async (node: TreeNode): Promise<TreeNode[]> => {
    try {
      const entries = (await window.filesAPI.readDirectory(node.path))
        .filter((e) => !isHiddenWorkspaceEntry(e.name));
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        children: e.isDirectory ? [] : undefined,
      }));
    } catch {
      return [];
    }
  }, []);

  const refreshTree = useCallback(async () => {
    await loadRoot();
    setRefreshKey((k) => k + 1);
  }, [loadRoot]);

  // Auto-refresh when files change on disk (e.g., created by container commands)
  useEffect(() => {
    return window.filesAPI.onWorkspaceChanged(() => {
      refreshTree();
    });
  }, [refreshTree]);

  const handleDropOnDir = useCallback(async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetPath(null);

    // Internal move
    const internalPath = e.dataTransfer.getData(INTERNAL_DRAG_TYPE);
    if (internalPath) {
      const parentDir = internalPath.substring(0, internalPath.lastIndexOf('/'));
      if (parentDir === targetDir) return;
      if (targetDir.startsWith(internalPath + '/')) return;
      await window.filesAPI.moveFile(internalPath, targetDir);
      await refreshTree();
      return;
    }

    // External copy
    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = window.filesAPI.getPathForFile(files[i]);
      if (filePath) paths.push(filePath);
    }

    if (paths.length > 0) {
      try {
        await window.filesAPI.copyToWorkspace(paths, targetDir);
      } finally {
        setCopyProgress(null);
      }
      await refreshTree();
    }
  }, [refreshTree]);

  const handleDragOverDir = useCallback((e: React.DragEvent, dirPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)) {
      e.dataTransfer.dropEffect = 'move';
    } else {
      e.dataTransfer.dropEffect = 'copy';
    }
    setDropTargetPath(dirPath);
  }, []);

  const handleDragLeaveDir = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !e.currentTarget.contains(related)) {
      setDropTargetPath(null);
    }
  }, []);

  // Fallback: external drops anywhere in the panel copy into workspace root
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropTargetPath) setDropTargetPath(workspacePath);
  }, [dropTargetPath, workspacePath]);

  const handleContainerDrop = useCallback(async (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)) return;
    e.preventDefault();
    setDropTargetPath(null);

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = window.filesAPI.getPathForFile(files[i]);
      if (filePath) paths.push(filePath);
    }

    if (paths.length > 0) {
      try {
        await window.filesAPI.copyToWorkspace(paths, workspacePath);
      } finally {
        setCopyProgress(null);
      }
      await refreshTree();
    }
  }, [workspacePath, refreshTree]);

  const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !e.currentTarget.contains(related)) {
      setDropTargetPath(null);
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!contextMenu) return;
    setContextMenu(null);
    await window.filesAPI.deleteFile(contextMenu.node.path);
    await refreshTree();
  }, [contextMenu, refreshTree]);

  const handleRenameStart = useCallback(() => {
    if (!contextMenu) return;
    setRenamingPath(contextMenu.node.path);
    setContextMenu(null);
  }, [contextMenu]);

  const handleShowInFinder = useCallback(async () => {
    if (!contextMenu) return;
    const targetPath = contextMenu.node.path;
    setContextMenu(null);
    await window.filesAPI.revealInFinder(targetPath);
  }, [contextMenu]);

  const handleSetTag = useCallback(async (tagType: FileTagType) => {
    if (!contextMenu || contextMenu.node.isDirectory) return;
    const node = contextMenu.node;
    setContextMenu(null);
    const relPath = resolveRelPath(node.path);
    await window.scannedFilesAPI.updateTag(relPath, node.name, tagType);
    setFileTagMap((prev) => new Map(prev).set(relPath, tagType));
  }, [contextMenu, resolveRelPath]);

  const handleRemoveTag = useCallback(async () => {
    if (!contextMenu || contextMenu.node.isDirectory) return;
    const node = contextMenu.node;
    setContextMenu(null);
    const relPath = resolveRelPath(node.path);
    await window.scannedFilesAPI.removeTag(relPath);
    setFileTagMap((prev) => {
      const next = new Map(prev);
      next.delete(relPath);
      return next;
    });
  }, [contextMenu, resolveRelPath]);

  const handleRenameNodePath = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleDeleteNodePath = useCallback(
    async (path: string) => {
      await window.filesAPI.deleteFile(path);
      await refreshTree();
    },
    [refreshTree],
  );

  const handleRenameCommit = useCallback(async (filePath: string, newName: string) => {
    setRenamingPath(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const oldName = filePath.split('/').pop() ?? '';
    if (trimmed === oldName) return;
    await window.filesAPI.renameFile(filePath, trimmed);
    await refreshTree();
  }, [refreshTree]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleImportFile = useCallback(async (destDir: string) => {
    const filePath = await window.filesAPI.selectFile();
    if (!filePath) return;
    try {
      await window.filesAPI.copyToWorkspace([filePath], destDir);
    } finally {
      setCopyProgress(null);
    }
    await refreshTree();
  }, [refreshTree]);

  const handleCreateNew = useCallback((dirPath: string, type: 'file' | 'folder') => {
    setContextMenu(null);
    if (dirPath === workspacePath) {
      setRootExpanded(true);
    }
    setCreatingIn({ dirPath, type });
  }, [workspacePath]);

  const handleCreateCommit = useCallback(async (name: string) => {
    if (!creatingIn) return;
    setCreatingIn(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const fullPath = creatingIn.dirPath + '/' + trimmed;
    if (creatingIn.type === 'file') {
      await window.filesAPI.createFile(fullPath);
    } else {
      await window.filesAPI.createDirectory(fullPath);
    }
    await refreshTree();
  }, [creatingIn, refreshTree]);

  const handleCreateCancel = useCallback(() => {
    setCreatingIn(null);
  }, []);

  return (
    <div
      className="filesTab"
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
      onDragLeave={handleContainerDragLeave}
    >
      <div className="filesTabTree">
        <div
          className={`fileTreeRow fileTreeRow--root ${dropTargetPath === workspacePath ? 'fileTreeRow--dropTarget' : ''}`}
          onClick={() => {
            if (!rootLoaded) {
              loadRoot();
            } else {
              setRootExpanded((v) => !v);
            }
          }}
          onDragOver={(e) => handleDragOverDir(e, workspacePath)}
          onDragLeave={handleDragLeaveDir}
          onDrop={(e) => handleDropOnDir(e, workspacePath)}
        >
          <ChevronRightIcon
            className={`fileTreeChevron ${rootExpanded ? 'fileTreeChevron--open' : ''}`}
          />
          <FolderOpenIcon className="fileTreeIcon" />
          <span className="fileTreeName fileTreeName--root">{workspaceName}</span>
          <div className="fileTreeRowActions">
            <button
              className="fileTreeRefresh"
              onClick={(e) => {
                e.stopPropagation();
                handleImportFile(workspacePath);
              }}
              title="Import file"
            >
              <FilePlusIcon style={{ width: 14, height: 14 }} />
            </button>
            <button
              className="fileTreeRefresh"
              onClick={(e) => {
                e.stopPropagation();
                handleCreateNew(workspacePath, 'folder');
              }}
              title="New folder"
            >
              <FolderPlusIcon style={{ width: 14, height: 14 }} />
            </button>
            <button
              className="fileTreeRefresh"
              onClick={(e) => {
                e.stopPropagation();
                refreshTree();
              }}
              title="Refresh files"
            >
              <RefreshCwIcon style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>
        {rootExpanded && creatingIn?.dirPath === workspacePath && (
          <div className="fileTreeRow" style={{ paddingLeft: fileTreeRowPaddingLeft(1) }}>
            {creatingIn.type === 'folder' ? (
              <FolderIcon className="fileTreeIcon" style={{ marginLeft: 18 }} />
            ) : (
              <>
                <span className="fileTreeChevronSpacer" />
                <FileIcon className="fileTreeIcon" />
              </>
            )}
            <RenameInput
              initialName=""
              onCommit={handleCreateCommit}
              onCancel={handleCreateCancel}
            />
          </div>
        )}
        {rootExpanded &&
          rootChildren.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={1}
              workspacePath={workspacePath}
              fileTagMap={fileTagMap}
              onSelectFile={onSelectFile}
              loadChildren={loadChildren}
              onDropOnDir={handleDropOnDir}
              onDragOverDir={handleDragOverDir}
              onDragLeaveDir={handleDragLeaveDir}
              dropTargetPath={dropTargetPath}
              refreshKey={refreshKey}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={handleRenameCancel}
              onRenameRequest={handleRenameNodePath}
              onDeleteRequest={handleDeleteNodePath}
              creatingIn={creatingIn}
              onCreateCommit={handleCreateCommit}
              onCreateCancel={handleCreateCancel}
            />
          ))}
        {localDirs.map((ud) => (
          <FileTreeNode
            key={ud.directory_path}
            node={{
              name: ud.display_name || ud.directory_path.split('/').pop() || ud.directory_path,
              path: ud.directory_path,
              isDirectory: true,
              children: [],
            }}
            depth={0}
            workspacePath={ud.directory_path}
            fileTagMap={fileTagMap}
            onSelectFile={onSelectFile}
            loadChildren={loadChildren}
            onDropOnDir={handleDropOnDir}
            onDragOverDir={handleDragOverDir}
            onDragLeaveDir={handleDragLeaveDir}
            dropTargetPath={dropTargetPath}
            refreshKey={refreshKey}
            onContextMenu={handleContextMenu}
            renamingPath={renamingPath}
            onRenameCommit={handleRenameCommit}
            onRenameCancel={handleRenameCancel}
            onRenameRequest={handleRenameNodePath}
            onDeleteRequest={handleDeleteNodePath}
            creatingIn={creatingIn}
            onCreateCommit={handleCreateCommit}
            onCreateCancel={handleCreateCancel}
            readOnly={ud.read_only}
            isToggling={togglingDirId === ud.id}
            onTogglePermission={() => handleTogglePermission(ud.id, ud.read_only)}
          />
        ))}
      </div>
      {copyProgress && (
        <div className="filesTabCopyProgress">
          <div className="filesTabCopyProgressBar">
            <div
              className="filesTabCopyProgressFill"
              style={{ width: `${(copyProgress.copied / copyProgress.total) * 100}%` }}
            />
          </div>
          <span className="filesTabCopyProgressText">
            Copying {copyProgress.currentName}... ({copyProgress.copied + 1} of {copyProgress.total})
          </span>
        </div>
      )}
      {contextMenu && (
        <div
          className="fileTreeContextMenu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node.isDirectory && (
            <>
              <button className="fileTreeContextMenuItem" onClick={() => handleCreateNew(contextMenu.node.path, 'file')}>
                New File
              </button>
              <button className="fileTreeContextMenuItem" onClick={() => handleCreateNew(contextMenu.node.path, 'folder')}>
                New Folder
              </button>
              <div className="fileTreeContextMenuSeparator" />
            </>
          )}
          {!contextMenu.node.isDirectory && (
            <>
              {(['manuscript', 'grant', 'presentation', 'reference'] as FileTagType[]).map((t) => {
                const relPath = resolveRelPath(contextMenu.node.path);
                const isActive = fileTagMap.get(relPath) === t;
                return (
                  <button
                    key={t}
                    className={`fileTreeContextMenuItem${isActive ? ' fileTreeContextMenuItem--active' : ''}`}
                    onClick={() => handleSetTag(t)}
                  >
                    Tag as {FILE_TAG_LABEL[t]}
                  </button>
                );
              })}
              {(() => {
                const relPath = resolveRelPath(contextMenu.node.path);
                return fileTagMap.has(relPath) ? (
                  <button className="fileTreeContextMenuItem fileTreeContextMenuItem--destructive" onClick={handleRemoveTag}>
                    Remove Tag
                  </button>
                ) : null;
              })()}
              <div className="fileTreeContextMenuSeparator" />
            </>
          )}
          <button className="fileTreeContextMenuItem" onClick={handleRenameStart}>
            Rename
          </button>
          <button className="fileTreeContextMenuItem" onClick={handleShowInFinder}>
            Show in Finder
          </button>
          <button className="fileTreeContextMenuItem fileTreeContextMenuItem--destructive" onClick={handleDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
};

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  workspacePath: string;
  fileTagMap: Map<string, FileTagType>;
  onSelectFile: (path: string) => void;
  loadChildren: (node: TreeNode) => Promise<TreeNode[]>;
  onDropOnDir: (e: React.DragEvent, targetDir: string) => void;
  onDragOverDir: (e: React.DragEvent, dirPath: string) => void;
  onDragLeaveDir: (e: React.DragEvent) => void;
  dropTargetPath: string | null;
  refreshKey: number;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  renamingPath: string | null;
  onRenameCommit: (filePath: string, newName: string) => void;
  onRenameCancel: () => void;
  onRenameRequest: (path: string) => void;
  onDeleteRequest: (path: string) => void | Promise<void>;
  creatingIn: { dirPath: string; type: 'file' | 'folder' } | null;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
  readOnly?: boolean;
  isToggling?: boolean;
  onTogglePermission?: () => void;
}

const FileTreeNode: FC<FileTreeNodeProps> = ({
  node,
  depth,
  workspacePath,
  fileTagMap,
  onSelectFile,
  loadChildren,
  onDropOnDir,
  onDragOverDir,
  onDragLeaveDir,
  dropTargetPath,
  refreshKey,
  onContextMenu,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
  onRenameRequest,
  onDeleteRequest,
  creatingIn,
  onCreateCommit,
  onCreateCancel,
  readOnly,
  isToggling,
  onTogglePermission,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const isRenaming = renamingPath === node.path;

  const relPath = node.path.startsWith(workspacePath + '/')
    ? node.path.slice(workspacePath.length + 1)
    : null;
  const fileTag = !node.isDirectory && relPath ? fileTagMap.get(relPath) : undefined;
  const isDocx = /\.docx$/i.test(node.name) && !node.isDirectory;

  // Expand (and load) so "New file/folder" is visible when the row toolbar or context menu targets this dir or a descendant.
  useEffect(() => {
    if (!creatingIn || !node.isDirectory) return;
    const target = creatingIn.dirPath;
    const mustReveal =
      target === node.path || target.startsWith(node.path + '/');
    if (!mustReveal) return;
    setExpanded(true);
    if (!loaded) {
      void loadChildren(node).then((kids) => {
        setChildren(kids);
        setLoaded(true);
      });
    }
  }, [creatingIn?.dirPath, creatingIn?.type, node.path, node.isDirectory, loadChildren, loaded]);

  // Re-fetch children when refreshKey changes (after copy/move operations) — skip Drive nodes
  // since their children come from the Drive API tree, not the local cache.
  useEffect(() => {
    if (loaded && expanded && node.isDirectory) {
      loadChildren(node).then(setChildren);
    }
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = async () => {
    if (isRenaming) return;
    if (node.isDirectory) {
      const willExpand = !expanded;
      setExpanded(willExpand);
      if (willExpand && !loaded) {
        const kids = await loadChildren(node);
        setChildren(kids);
        setLoaded(true);
      }
    } else {
      onSelectFile(node.path);
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const isDropTarget = node.isDirectory && dropTargetPath === node.path;

  return (
    <>
      <div
        className={`fileTreeRow fileTreeRow--node ${isDocx ? 'fileTreeRow--hasWordAction' : ''} ${isDropTarget ? 'fileTreeRow--dropTarget' : ''}`}
        style={{ paddingLeft: fileTreeRowPaddingLeft(depth) }}
        onContextMenu={(e) => onContextMenu(e, node)}
        {...(node.isDirectory
          ? {
            onDragOver: (e: React.DragEvent) => onDragOverDir(e, node.path),
            onDragLeave: onDragLeaveDir,
            onDrop: (e: React.DragEvent) => onDropOnDir(e, node.path),
          }
          : {})}
      >
        <div
          className="fileTreeRowMain"
          onClick={handleClick}
          draggable={!isRenaming}
          onDragStart={handleDragStart}
        >
          {node.isDirectory ? (
            <>
              <ChevronRightIcon
                className={`fileTreeChevron ${expanded ? 'fileTreeChevron--open' : ''}`}
              />
              {expanded ? (
                <FolderOpenIcon className="fileTreeIcon" />
              ) : (
                <FolderIcon className="fileTreeIcon" />
              )}
            </>
          ) : (
            <>
              <span className="fileTreeChevronSpacer" />
              <FileIcon className="fileTreeIcon" />
            </>
          )}
          {isRenaming ? (
            <RenameInput
              initialName={node.name}
              onCommit={(newName) => onRenameCommit(node.path, newName)}
              onCancel={onRenameCancel}
            />
          ) : (
            <>
              <span className="fileTreeName">{node.name}</span>
              {onTogglePermission !== undefined && (
                <DirectoryPermBadge
                  readOnly={!!readOnly}
                  isToggling={!!isToggling}
                  onToggle={onTogglePermission}
                />
              )}
              {fileTag && (
                <span className={`fileTreeTag fileTreeTag--${fileTag}`}>
                  {FILE_TAG_LABEL[fileTag]}
                </span>
              )}
            </>
          )}
        </div>
        {!isRenaming && (
          <div className="fileTreeRowActions">
            {isDocx && (
              <button
                type="button"
                className="fileTreeRowAction fileTreeRowAction--word"
                title="Open in Word"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!(await ensureAccessibilityPermission())) return;
                  const fileUrl = `file://${node.path}`;
                  window.fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word');
                  window.fileMonitorAPI.setDockRightForDocument(node.path, true);
                }}
              >
                <FileTextIcon style={{ width: 14, height: 14 }} />
              </button>
            )}
            <button
              type="button"
              className="fileTreeRowAction"
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                onRenameRequest(node.path);
              }}
            >
              <PencilIcon style={{ width: 14, height: 14 }} />
            </button>
            <button
              type="button"
              className="fileTreeRowAction fileTreeRowAction--delete"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                void onDeleteRequest(node.path);
              }}
            >
              <TrashIcon style={{ width: 14, height: 14 }} />
            </button>
          </div>
        )}
      </div>
      {expanded && creatingIn?.dirPath === node.path && (
        <div className="fileTreeRow" style={{ paddingLeft: fileTreeRowPaddingLeft(depth + 1) }}>
          {creatingIn.type === 'folder' ? (
            <FolderIcon className="fileTreeIcon" style={{ marginLeft: 18 }} />
          ) : (
            <>
              <span className="fileTreeChevronSpacer" />
              <FileIcon className="fileTreeIcon" />
            </>
          )}
          <RenameInput
            initialName=""
            onCommit={onCreateCommit}
            onCancel={onCreateCancel}
          />
        </div>
      )}
      {expanded &&
        children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            workspacePath={workspacePath}
            fileTagMap={fileTagMap}
            onSelectFile={onSelectFile}
            loadChildren={loadChildren}
            onDropOnDir={onDropOnDir}
            onDragOverDir={onDragOverDir}
            onDragLeaveDir={onDragLeaveDir}
            dropTargetPath={dropTargetPath}
            refreshKey={refreshKey}
            onContextMenu={onContextMenu}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            onRenameRequest={onRenameRequest}
            onDeleteRequest={onDeleteRequest}
            creatingIn={creatingIn}
            onCreateCommit={onCreateCommit}
            onCreateCancel={onCreateCancel}
          />
        ))}
    </>
  );
};

const RenameInput: FC<{
  initialName: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}> = ({ initialName, onCommit, onCancel }) => {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="fileTreeRenameInput"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value);
        if (e.key === 'Escape') onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
};
