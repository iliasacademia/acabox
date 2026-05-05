import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { PLAN_COLORS } from './calendarColors';
import type { CalendarGroup, CalendarEvent, EventDependency, CalendarResource, CreateResourceData } from '../../shared/types';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function groupDateRange(events: CalendarEvent[]): string | null {
  if (events.length === 0) return null;
  const starts = events.map(e => e.start_at).sort();
  const ends = events.map(e => e.end_at).sort();
  const startLabel = formatDateShort(starts[0]);
  const endLabel = formatDateShort(ends[ends.length - 1]);
  if (startLabel === endLabel) return startLabel;
  return `${startLabel} – ${endLabel}`;
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function hexLuminance(hex: string): number {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lin = (v: number) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function groupHeaderTextColor(hex: string): string {
  return hexLuminance(hex) > 0.35 ? '#2C2C28' : '#f9f8f6';
}

function resourceDisplayTitle(r: CalendarResource): string {
  if (r.title) return r.title;
  if (r.type === 'file' && r.file_path) return basename(r.file_path);
  if (r.type === 'link' && r.url) return r.url;
  if (r.type === 'folder') return 'Folder';
  return 'Untitled note';
}

// ---- SVG icons ----

function FileIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <path d="M2 1.5h5l2 2v6.5H2v-8.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M6.5 1.5v2H9" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <path d="M1 4.5h9v5H1V4.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M1 4.5V3H3.5l1 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <path d="M1 4.5h9v5H1V4.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M1 4.5V3H3.5l1 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      <path d="M3 7h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <path d="M4.5 6.5a2.2 2.2 0 003.1-3.1L6.4 2.2a2.2 2.2 0 00-3.1 3.1l.4.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      <path d="M6.5 4.5a2.2 2.2 0 00-3.1 3.1l1.2 1.2a2.2 2.2 0 003.1-3.1L7.3 5.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <rect x="1.5" y="1.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.1"/>
      <path d="M3.5 4h4M3.5 5.8h4M3.5 7.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.1"/>
      <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.1"/>
    </svg>
  );
}

function EventIcon() {
  return (
    <svg className="overviewResourceIcon" viewBox="0 0 11 11" fill="none">
      <rect x="1.5" y="2.5" width="8" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/>
      <path d="M1.5 5h8" stroke="currentColor" strokeWidth="1.1"/>
      <path d="M3.5 1.5v2M7.5 1.5v2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  );
}

function ResourceTypeIcon({ type, open }: { type: CalendarResource['type']; open?: boolean }) {
  if (type === 'file') return <FileIcon />;
  if (type === 'link') return <LinkIcon />;
  if (type === 'folder') return open ? <FolderOpenIcon /> : <FolderIcon />;
  return <NoteIcon />;
}

// ---- Resource tree ----

interface ResourceTreeNode {
  resource: CalendarResource;
  children: ResourceTreeNode[];
}

function buildResourceTree(resources: CalendarResource[], parentId: string | null = null): ResourceTreeNode[] {
  return resources
    .filter(r => r.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map(r => ({ resource: r, children: buildResourceTree(resources, r.id) }));
}

// ---- Scope types ----

type ResourceScope =
  | { type: 'group'; id: string }
  | { type: 'event'; id: string }
  | { type: 'floating' };

// ---- Shared modal + context-menu types ----

type ModalType = CalendarResource['type'] | 'group' | 'event';

interface ResourceModalState {
  mode: 'create' | 'edit';
  type: ModalType | null;
  resource: CalendarResource | null;
  scopeProps: Pick<CreateResourceData, 'group_id' | 'event_id'>;
  scopeLabel: string;
  anchorX: number;
  anchorY: number;
  parentId?: string | null;
}

interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

// ---- ResourceEditModal ----

const POPOVER_W = 288;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ResourceEditModal({ state, groups, onClose, onMutated, onGroupCreated, onEventCreated }: {
  state: ResourceModalState;
  groups: CalendarGroup[];
  onClose: () => void;
  onMutated: () => void;
  onGroupCreated?: (group: CalendarGroup) => void;
  onEventCreated?: (event: CalendarEvent) => void;
}) {
  const isWorkspace = state.scopeProps.group_id === null && state.scopeProps.event_id === null;

  const initialStep: ModalType | 'pick' =
    state.mode === 'edit' ? state.resource!.type : state.type ?? 'pick';
  const [step, setStep] = useState<ModalType | 'pick'>(initialStep);

  // resource fields
  const [title, setTitle] = useState(state.resource?.title ?? '');
  const [noteContent, setNoteContent] = useState(state.resource?.note_content ?? '');
  const [url, setUrl] = useState(state.resource?.url ?? '');

  // group fields
  const [groupName, setGroupName] = useState('');
  const [groupColorIdx, setGroupColorIdx] = useState(0);

  // event fields
  const [eventName, setEventName] = useState('');
  const [eventStart, setEventStart] = useState(() => todayISO());
  const [eventEnd, setEventEnd] = useState(() => todayISO());
  const [eventGroupId, setEventGroupId] = useState('');

  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const left = Math.min(state.anchorX + 8, window.innerWidth - POPOVER_W - 8);
  const top = Math.max(8, Math.min(state.anchorY - 16, window.innerHeight - 500));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (step !== 'pick' && state.mode === 'create' && state.type == null) {
        setStep('pick');
      } else {
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, step, state]);

  async function handlePickFile() {
    const paths = await window.calendarAPI.pickResourceFile();
    if (!paths || paths.length === 0) return;
    await Promise.all(paths.map(fp =>
      window.calendarAPI.createResource({ type: 'file', ...state.scopeProps, parent_id: state.parentId ?? null, file_path: fp, title: basename(fp) })
    ));
    onMutated();
    onClose();
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (state.mode === 'edit' && state.resource) {
        if (step === 'note') {
          await window.calendarAPI.updateResource(state.resource.id, { title, note_content: noteContent });
        } else if (step === 'link') {
          await window.calendarAPI.updateResource(state.resource.id, { url: url.trim(), title: title.trim() || url.trim() });
        } else if (step === 'folder') {
          await window.calendarAPI.updateResource(state.resource.id, { title });
        }
      } else {
        if (step === 'note') {
          await window.calendarAPI.createResource({ type: 'note', ...state.scopeProps, parent_id: state.parentId ?? null, title, note_content: noteContent });
        } else if (step === 'link') {
          if (!url.trim()) return;
          await window.calendarAPI.createResource({ type: 'link', ...state.scopeProps, parent_id: state.parentId ?? null, url: url.trim(), title: title.trim() || url.trim() });
        } else if (step === 'folder') {
          await window.calendarAPI.createResource({ type: 'folder', ...state.scopeProps, parent_id: state.parentId ?? null, title: title || 'New Folder' });
        } else if (step === 'group') {
          if (!groupName.trim()) return;
          const group = await window.calendarAPI.createGroup({ name: groupName.trim(), color: PLAN_COLORS[groupColorIdx].shades[600] });
          onGroupCreated?.(group);
        } else if (step === 'event') {
          if (!eventName.trim() || !eventStart) return;
          const end = eventEnd && eventEnd >= eventStart ? eventEnd : eventStart;
          const event = await window.calendarAPI.createEvent({
            name: eventName.trim(),
            start_at: `${eventStart}T09:00:00`,
            end_at: `${end}T17:00:00`,
            group_id: eventGroupId || null,
          });
          onEventCreated?.(event);
        }
      }
      onMutated();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!state.resource) return;
    await window.calendarAPI.deleteResource(state.resource.id);
    onMutated();
    onClose();
  }

  const canSave =
    step === 'note' ||
    (step === 'link' && url.trim().length > 0) ||
    (step === 'folder' && title.trim().length > 0) ||
    (step === 'group' && groupName.trim().length > 0) ||
    (step === 'event' && eventName.trim().length > 0 && eventStart.length > 0);

  const titleLabel =
    state.mode === 'edit' ? `Edit ${step}`
    : step === 'pick' ? (isWorkspace ? 'Create new' : `Add to ${state.scopeLabel}`)
    : step === 'group' ? 'New group'
    : step === 'event' ? 'New event'
    : `Add ${step}`;

  return (
    <div ref={containerRef} className="resModalPanel" style={{ left, top }}>
      <div className="resModalHeader">
        {step !== 'pick' && state.mode === 'create' && state.type == null && (
          <button className="resModalBackBtn" onClick={() => setStep('pick')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2.5L4.5 6l3 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
        <span className="resModalTitle">{titleLabel}</span>
        <button className="resModalCloseBtn" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {step === 'pick' && (
        <div className={`resModalTypePicker${isWorkspace ? ' resModalTypePicker6' : ''}`}>
          {isWorkspace && (
            <>
              <button className="resModalTypeBtn" onClick={() => setStep('group')}>
                <GroupIcon /><span>Group</span>
              </button>
              <button className="resModalTypeBtn" onClick={() => setStep('event')}>
                <EventIcon /><span>Event</span>
              </button>
            </>
          )}
          <button className="resModalTypeBtn" onClick={handlePickFile}>
            <FileIcon /><span>File</span>
          </button>
          <button className="resModalTypeBtn" onClick={() => setStep('link')}>
            <LinkIcon /><span>Link</span>
          </button>
          <button className="resModalTypeBtn" onClick={() => setStep('note')}>
            <NoteIcon /><span>Note</span>
          </button>
          <button className="resModalTypeBtn" onClick={() => setStep('folder')}>
            <FolderIcon /><span>Folder</span>
          </button>
        </div>
      )}

      {step === 'group' && (
        <div className="resModalForm">
          <label className="resModalLabel">Name</label>
          <input
            className="resModalInput"
            placeholder="Group name"
            value={groupName}
            autoFocus
            onChange={e => setGroupName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && groupName.trim()) handleSave(); }}
          />
          <label className="resModalLabel">Color</label>
          <div className="resModalColorPicker">
            {PLAN_COLORS.map((fam, i) => (
              <button
                key={fam.family}
                className={`overviewNewGroupSwatch${groupColorIdx === i ? ' overviewNewGroupSwatchSel' : ''}`}
                style={{ backgroundColor: fam.shades[600] }}
                onClick={() => setGroupColorIdx(i)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 'event' && (
        <div className="resModalForm">
          <label className="resModalLabel">Name</label>
          <input
            className="resModalInput"
            placeholder="Event name"
            value={eventName}
            autoFocus
            onChange={e => setEventName(e.target.value)}
          />
          <label className="resModalLabel">Start</label>
          <input
            className="resModalInput resModalDateInput"
            type="date"
            value={eventStart}
            onChange={e => { setEventStart(e.target.value); if (!eventEnd || eventEnd < e.target.value) setEventEnd(e.target.value); }}
          />
          <label className="resModalLabel">End</label>
          <input
            className="resModalInput resModalDateInput"
            type="date"
            value={eventEnd}
            min={eventStart}
            onChange={e => setEventEnd(e.target.value)}
          />
          {groups.length > 0 && (
            <>
              <label className="resModalLabel">Group</label>
              <select
                className="resModalInput resModalSelect"
                value={eventGroupId}
                onChange={e => setEventGroupId(e.target.value)}
              >
                <option value="">No group</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {step === 'note' && (
        <div className="resModalForm">
          <label className="resModalLabel">Title</label>
          <input
            className="resModalInput"
            placeholder="Optional title"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <label className="resModalLabel">Content</label>
          <textarea
            className="resModalTextarea"
            placeholder="Write a note…"
            value={noteContent}
            autoFocus
            onChange={e => setNoteContent(e.target.value)}
          />
        </div>
      )}

      {step === 'link' && (
        <div className="resModalForm">
          <label className="resModalLabel">URL</label>
          <input
            className="resModalInput"
            placeholder="https://…"
            value={url}
            autoFocus
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && url.trim()) handleSave(); }}
          />
          <label className="resModalLabel">Title (optional)</label>
          <input
            className="resModalInput"
            placeholder="Display name"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && url.trim()) handleSave(); }}
          />
        </div>
      )}

      {step === 'folder' && (
        <div className="resModalForm">
          <label className="resModalLabel">Folder Name</label>
          <input
            className="resModalInput"
            placeholder="Folder name"
            value={title}
            autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && title.trim()) handleSave(); }}
          />
        </div>
      )}

      {step !== 'pick' && (
        <div className="resModalFooter">
          {state.mode === 'edit' && state.resource && (
            <button className="resModalDeleteBtn" onClick={handleDelete}>Delete</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="resModalCancelBtn" onClick={onClose}>Cancel</button>
          <button className="resModalSaveBtn" onClick={handleSave} disabled={saving || !canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- ContextMenu ----

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 160);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 12);

  return (
    <div ref={ref} className="resContextMenu" style={{ left, top }}>
      {items.map((item, i) => (
        <button
          key={i}
          className={`resContextItem${item.danger ? ' resContextItemDanger' : ''}`}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ---- ResourceSection ----

interface ResourceSectionProps {
  scope: ResourceScope;
  resources: CalendarResource[];
  indent: number;
  onMutated: () => void;
  onOpenModal: (state: ResourceModalState) => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

function ResourceSection({ scope, resources, indent, onMutated, onOpenModal, onOpenContextMenu }: ResourceSectionProps) {
  const [folderExpanded, setFolderExpanded] = useState<Set<string>>(new Set());
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');

  const scopeProps: Pick<CreateResourceData, 'group_id' | 'event_id'> = {
    group_id: scope.type === 'group' ? scope.id : null,
    event_id: scope.type === 'event' ? scope.id : null,
  };
  const scopeLabel = scope.type === 'event' ? 'Event' : scope.type === 'group' ? 'Group' : 'Workspace';

  const openAddModal = (type: CalendarResource['type'] | null = null, ax = 0, ay = 0, parentId?: string | null) => {
    onOpenModal({ mode: 'create', type, resource: null, scopeProps, scopeLabel, anchorX: ax, anchorY: ay, parentId });
  };

  const openEditModal = (r: CalendarResource, ax = 0, ay = 0) => {
    onOpenModal({ mode: 'edit', type: r.type, resource: r, scopeProps, scopeLabel, anchorX: ax, anchorY: ay });
  };

  const handleDelete = async (id: string) => {
    await window.calendarAPI.deleteResource(id);
    onMutated();
  };

  const handleTitleSave = async (id: string) => {
    await window.calendarAPI.updateResource(id, { title: editingTitleValue });
    setEditingTitleId(null);
    onMutated();
  };

  const handleResourceClick = (r: CalendarResource, ax: number, ay: number) => {
    if (r.type === 'file' && r.file_path) window.calendarAPI.openResourceFile(r.file_path);
    else if (r.type === 'link' && r.url) window.calendarAPI.openResourceUrl(r.url);
    else if (r.type === 'note') openEditModal(r, ax, ay);
    else if (r.type === 'folder') toggleFolder(r.id);
  };

  const showResourceContextMenu = (e: React.MouseEvent, r: CalendarResource) => {
    e.preventDefault();
    e.stopPropagation();
    const ax = e.clientX;
    const ay = e.clientY;
    onOpenContextMenu(ax, ay, [
      ...(r.type === 'note' || r.type === 'link' || r.type === 'folder'
        ? [{ label: 'Edit', onClick: () => openEditModal(r, ax, ay) }]
        : []),
      ...(r.type === 'file' && r.file_path
        ? [{ label: 'Reveal in Finder', onClick: () => window.calendarAPI.revealResourceFile(r.file_path!) }]
        : []),
      { label: 'Delete', onClick: () => handleDelete(r.id), danger: true },
    ]);
  };

  const showSectionContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ax = e.clientX;
    const ay = e.clientY;
    onOpenContextMenu(ax, ay, [
      { label: 'Add File', onClick: async () => {
        const paths = await window.calendarAPI.pickResourceFile();
        if (!paths || paths.length === 0) return;
        await Promise.all(paths.map(fp =>
          window.calendarAPI.createResource({ type: 'file', ...scopeProps, file_path: fp, title: basename(fp) })
        ));
        onMutated();
      }},
      { label: 'Add Link', onClick: () => openAddModal('link', ax, ay) },
      { label: 'Add Note', onClick: () => openAddModal('note', ax, ay) },
      { label: 'Add Folder', onClick: () => openAddModal('folder', ax, ay) },
    ]);
  };

  const toggleFolder = (id: string) => {
    setFolderExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const handleDrop = async (e: React.DragEvent, targetFolderId: string | null) => {
    const resourceId = e.dataTransfer.getData('application/resource-id');
    if (!resourceId || resourceId === targetFolderId) { setDragOverTarget(null); return; }
    e.preventDefault();
    e.stopPropagation();
    await window.calendarAPI.moveResource(resourceId, { parent_id: targetFolderId });
    setDragOverTarget(null);
    onMutated();
  };

  const tree = useMemo(() => buildResourceTree(resources), [resources]);

  function renderNode(node: ResourceTreeNode, depth: number): React.ReactNode {
    const r = node.resource;
    const isFolder = r.type === 'folder';
    const isFolderOpen = isFolder && folderExpanded.has(r.id);
    const isDragOver = dragOverTarget === r.id;
    const isEditingTitle = editingTitleId === r.id;
    const rowIndent = depth * 12;

    return (
      <React.Fragment key={r.id}>
        <div className="overviewResourceRowWrap" style={{ marginLeft: `${rowIndent}px` }}>
        <button
          className={`overviewResourceRow${isFolder ? ' overviewFolderRow' : ''}${isDragOver ? ' overviewResourceDropTarget' : ''}`}
          draggable
          onDragStart={e => { e.dataTransfer.setData('application/resource-id', r.id); e.stopPropagation(); }}
          onDragOver={e => {
            if (!e.dataTransfer.types.includes('application/resource-id')) return;
            e.preventDefault(); e.stopPropagation();
            if (isFolder && dragOverTarget !== r.id) setDragOverTarget(r.id);
          }}
          onDragLeave={() => { if (dragOverTarget === r.id) setDragOverTarget(null); }}
          onDrop={e => { if (isFolder) handleDrop(e, r.id); }}
          onClick={e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); handleResourceClick(r, rect.right, rect.top + rect.height / 2); }}
          onContextMenu={e => showResourceContextMenu(e, r)}
        >
          {isFolder ? (
            <svg className={`overviewChevron${isFolderOpen ? ' overviewChevronOpen' : ''}`} width="13" height="13" viewBox="0 0 10 10" fill="none">
              <path d="M3.5 2.5L6 5L3.5 7.5" stroke="#9B9B95" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <span className="overviewResourceIconSpacer" />
          )}
          <ResourceTypeIcon type={r.type} open={isFolderOpen} />
          {r.ai_generated === 1 && <span className="aiResourceSparkle" title="AI-suggested">✦</span>}
          {isEditingTitle ? (
            <input
              className="overviewResourceTitleInput"
              value={editingTitleValue}
              autoFocus
              onClick={e => e.stopPropagation()}
              onChange={e => setEditingTitleValue(e.target.value)}
              onBlur={() => handleTitleSave(r.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleTitleSave(r.id);
                if (e.key === 'Escape') setEditingTitleId(null);
              }}
            />
          ) : (
            <span
              className="overviewResourceTitle"
              onDoubleClick={e => {
                e.stopPropagation();
                setEditingTitleId(r.id);
                setEditingTitleValue(r.title || resourceDisplayTitle(r));
              }}
            >
              {resourceDisplayTitle(r)}
            </span>
          )}
          <button
            className="overviewResourceDeleteBtn"
            onClick={e => { e.stopPropagation(); handleDelete(r.id); }}
            title="Remove"
          >×</button>
        </button>
        {isFolder && (
          <button
            className="overviewResourceAddBtn"
            onClick={e => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openAddModal(null, rect.right, rect.top + rect.height / 2, r.id);
            }}
            title="Add to folder"
          >+</button>
        )}
        </div>
        {isFolderOpen && node.children.length > 0 && (
          <div className="overviewFolderChildren">
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </React.Fragment>
    );
  }

  if (resources.length === 0) return null;

  return (
    <div className="overviewResourceList" style={{ marginLeft: `${indent}px` }} onContextMenu={showSectionContextMenu}>
      {tree.map(node => renderNode(node, 0))}
    </div>
  );
}

// ---- EventItem ----

interface EventItemProps {
  event: CalendarEvent;
  groupColor: string;
  resources: CalendarResource[];
  isLinked: boolean;
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onEventDragStart: (event: CalendarEvent) => void;
  onResourceMutated: () => void;
  onOpenModal: (state: ResourceModalState) => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

function EventItem({ event, groupColor, resources, isLinked, onEventClick, onEventDragStart, onResourceMutated, onOpenModal, onOpenContextMenu }: EventItemProps) {
  const [dragOver, setDragOver] = useState(false);

  const scopeProps: Pick<CreateResourceData, 'group_id' | 'event_id'> = {
    group_id: null,
    event_id: event.id,
  };

  const showAddContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ax = e.clientX;
    const ay = e.clientY;
    onOpenContextMenu(ax, ay, [
      { label: 'Add File', onClick: async () => {
        const paths = await window.calendarAPI.pickResourceFile();
        if (!paths || paths.length === 0) return;
        await Promise.all(paths.map(fp =>
          window.calendarAPI.createResource({ type: 'file', ...scopeProps, file_path: fp, title: basename(fp) })
        ));
        onResourceMutated();
      }},
      { label: 'Add Link', onClick: () => onOpenModal({ mode: 'create', type: 'link', resource: null, scopeProps, scopeLabel: event.name, anchorX: ax, anchorY: ay }) },
      { label: 'Add Note', onClick: () => onOpenModal({ mode: 'create', type: 'note', resource: null, scopeProps, scopeLabel: event.name, anchorX: ax, anchorY: ay }) },
      { label: 'Add Folder', onClick: () => onOpenModal({ mode: 'create', type: 'folder', resource: null, scopeProps, scopeLabel: event.name, anchorX: ax, anchorY: ay }) },
    ]);
  };

  return (
    <>
      <div className="overviewEventRowWrap">
        <button
          className={`overviewEventRow${dragOver ? ' overviewEventRowDragOver' : ''}`}
          draggable
          onDragStart={() => onEventDragStart(event)}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            onEventClick?.(event, r.right, r.top + r.height / 2);
          }}
          onContextMenu={showAddContextMenu}
          onDragOver={e => {
            if (!e.dataTransfer.types.includes('application/resource-id')) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async e => {
            const resourceId = e.dataTransfer.getData('application/resource-id');
            if (!resourceId) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            await window.calendarAPI.moveResource(resourceId, { event_id: event.id, group_id: null, parent_id: null });
            onResourceMutated();
          }}
        >
          <span
            className={`overviewEventDot${event.status !== 'active' ? ' overviewEventDotInactive' : ''}`}
            style={event.status === 'active' ? { backgroundColor: groupColor } : { borderColor: groupColor }}
          />
          <span className="overviewEventName">{event.name}</span>
          <span className="overviewEventDate">{formatDateShort(event.start_at)}</span>
        </button>
        <button
          className="overviewEventAddBtn"
          onClick={e => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenModal({ mode: 'create', type: null, resource: null, scopeProps, scopeLabel: event.name, anchorX: rect.right, anchorY: rect.top + rect.height / 2 });
          }}
          title="Add file, link or note"
        >+</button>
      </div>
      {isLinked && <div className="overviewDepConnector" style={{ borderColor: groupColor }} />}
      <ResourceSection
        scope={{ type: 'event', id: event.id }}
        resources={resources}
        indent={36}
        onMutated={onResourceMutated}
        onOpenModal={onOpenModal}
        onOpenContextMenu={onOpenContextMenu}
      />
    </>
  );
}

// ---- GroupRow ----

interface GroupRowProps {
  group: CalendarGroup;
  events: CalendarEvent[];
  dependencies: EventDependency[];
  groupResources: CalendarResource[];
  eventResourcesMap: Map<string, CalendarResource[]>;
  isDragOver: boolean;
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onEventDragStart: (event: CalendarEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDeleteClick: () => void;
  onRename: (newName: string) => Promise<void>;
  onResourceMutated: () => void;
  onOpenModal: (state: ResourceModalState) => void;
  onOpenContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

function GroupRow({ group, events, dependencies, groupResources, eventResourcesMap, isDragOver, onEventClick, onEventDragStart, onDragOver, onDragLeave, onDrop, onDeleteClick, onRename, onResourceMutated, onOpenModal, onOpenContextMenu }: GroupRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const dateRange = useMemo(() => groupDateRange(events), [events]);

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setRenameValue(group.name);
    setRenaming(true);
    setTimeout(() => { renameRef.current?.select(); }, 0);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed && trimmed !== group.name) await onRename(trimmed);
  }

  const linkedPairs = useMemo(() => {
    const eventIds = new Set(events.map(e => e.id));
    const pairs = new Set<string>();
    for (const dep of dependencies) {
      if (eventIds.has(dep.predecessor_id) && eventIds.has(dep.successor_id)) {
        pairs.add([dep.predecessor_id, dep.successor_id].sort().join('|'));
      }
    }
    return pairs;
  }, [events, dependencies]);

  function isLinkedToNext(a: CalendarEvent, b: CalendarEvent): boolean {
    return linkedPairs.has([a.id, b.id].sort().join('|'));
  }

  const textColor = groupHeaderTextColor(group.color);
  const iconOpacity = hexLuminance(group.color) > 0.35 ? '0.5' : '0.7';

  return (
    <div
      className={`overviewGroup${isDragOver ? ' overviewGroupDragOver' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="overviewGroupHeaderWrap" style={{ backgroundColor: group.color, borderRadius: '5px' }}>
        <button
          className="overviewGroupHeader"
          onClick={() => { if (!renaming) setExpanded(prev => !prev); }}
        >
          <svg
            className={`overviewChevron${expanded ? ' overviewChevronOpen' : ''}`}
            width="13" height="13" viewBox="0 0 10 10" fill="none"
            style={{ opacity: iconOpacity }}
          >
            <path d="M3.5 2.5L6 5L3.5 7.5" stroke={textColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div className="overviewGroupMeta">
            {renaming ? (
              <input
                ref={renameRef}
                className="overviewGroupRenameInput"
                style={{ color: textColor }}
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); }
                }}
                onClick={e => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <span className="overviewGroupName" style={{ color: textColor }} onDoubleClick={startRename}>{group.name}</span>
            )}
            {!renaming && dateRange && (
              <span className="overviewGroupRange" style={{ color: textColor, opacity: 0.72 }}>{dateRange}</span>
            )}
          </div>
        </button>
        <button
          className="overviewGroupAddBtn"
          style={{ color: textColor, opacity: 0.6 }}
          onClick={e => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenModal({ mode: 'create', type: null, resource: null, scopeProps: { group_id: group.id, event_id: null }, scopeLabel: group.name, anchorX: rect.right, anchorY: rect.top + rect.height / 2 });
          }}
          title="Add to group"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          className="overviewGroupDeleteBtn"
          style={{ color: textColor, opacity: 0.6 }}
          onClick={e => { e.stopPropagation(); onDeleteClick(); }}
          title="Remove group"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="overviewGroupBody">
          {events.map((event, i) => (
            <EventItem
              key={event.id}
              event={event}
              groupColor={group.color}
              resources={eventResourcesMap.get(event.id) ?? []}
              isLinked={i < events.length - 1 && isLinkedToNext(event, events[i + 1])}
              onEventClick={onEventClick}
              onEventDragStart={onEventDragStart}
              onResourceMutated={onResourceMutated}
              onOpenModal={onOpenModal}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
          <ResourceSection
            scope={{ type: 'group', id: group.id }}
            resources={groupResources}
            indent={24}
            onMutated={onResourceMutated}
            onOpenModal={onOpenModal}
            onOpenContextMenu={onOpenContextMenu}
          />
        </div>
      )}
    </div>
  );
}

// ---- NewGroupForm — kept for inline use if needed ----

interface NewGroupFormProps {
  onSubmit: (name: string, color: string) => Promise<void>;
  onCancel: () => void;
}

function NewGroupForm({ onSubmit, onCancel }: NewGroupFormProps) {
  const [name, setName] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    await onSubmit(trimmed, PLAN_COLORS[colorIdx].shades[600]);
  }

  return (
    <div className="overviewNewGroupForm">
      <input
        ref={inputRef}
        className="overviewNewGroupInput"
        placeholder="Group name"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="overviewNewGroupColors">
        {PLAN_COLORS.map((fam, i) => (
          <button
            key={fam.family}
            className={`overviewNewGroupSwatch${colorIdx === i ? ' overviewNewGroupSwatchSel' : ''}`}
            style={{ backgroundColor: fam.shades[600] }}
            onClick={() => setColorIdx(i)}
          />
        ))}
      </div>
      <div className="overviewNewGroupActions">
        <button className="overviewNewGroupCancel" onClick={onCancel}>Cancel</button>
        <button
          className="overviewNewGroupCreate"
          disabled={!name.trim() || saving}
          onClick={handleSubmit}
        >
          {saving ? '…' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ---- CalendarSidebar ----

interface CalendarSidebarProps {
  groups: CalendarGroup[];
  allEvents: CalendarEvent[];
  dependencies: EventDependency[];
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onReassign: (eventId: string, newGroupId: string | null) => void;
  onDeleteGroup: (groupId: string, deleteEvents: boolean) => void;
  onCreateGroup: (name: string, color: string) => Promise<void>;
  onRenameGroup: (groupId: string, newName: string) => Promise<void>;
  onGroupCreated: (group: CalendarGroup) => void;
  onEventCreated: (event: CalendarEvent) => void;
}

export function CalendarSidebar({ groups, allEvents, dependencies, onEventClick, onReassign, onDeleteGroup, onCreateGroup, onRenameGroup, onGroupCreated, onEventCreated }: CalendarSidebarProps) {
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);
  const draggingEventRef = useRef<CalendarEvent | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | 'unorganized' | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<CalendarGroup | null>(null);
  const [resources, setResources] = useState<CalendarResource[]>([]);
  const [resModal, setResModal] = useState<ResourceModalState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const reloadResources = useCallback(async () => {
    const all = await window.calendarAPI.listResources({});
    setResources(all);
  }, []);

  useEffect(() => { reloadResources(); }, [reloadResources]);

  const resourcesByGroup = useMemo(() => {
    const m = new Map<string, CalendarResource[]>();
    for (const r of resources) {
      if (r.group_id && !r.event_id) {
        const arr = m.get(r.group_id) ?? [];
        arr.push(r);
        m.set(r.group_id, arr);
      }
    }
    return m;
  }, [resources]);

  const resourcesByEvent = useMemo(() => {
    const m = new Map<string, CalendarResource[]>();
    for (const r of resources) {
      if (r.event_id) {
        const arr = m.get(r.event_id) ?? [];
        arr.push(r);
        m.set(r.event_id, arr);
      }
    }
    return m;
  }, [resources]);

  const floatingResources = useMemo(
    () => resources.filter(r => !r.group_id && !r.event_id),
    [resources]
  );

  const eventsByGroup = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of allEvents) {
      if (event.group_id) {
        const arr = map.get(event.group_id) ?? [];
        arr.push(event);
        map.set(event.group_id, arr);
      }
    }
    for (const [id, arr] of map) {
      map.set(id, arr.slice().sort((a, b) => a.start_at.localeCompare(b.start_at)));
    }
    return map;
  }, [allEvents]);

  const unplannedEvents = useMemo(
    () => allEvents.filter(e => !e.group_id && e.status !== 'inactive_hidden')
      .sort((a, b) => a.start_at.localeCompare(b.start_at)),
    [allEvents],
  );

  function startDraggingEvent(event: CalendarEvent) {
    draggingEventRef.current = event;
    setDraggingEvent(event);
  }

  function clearDraggingEvent() {
    draggingEventRef.current = null;
    setDraggingEvent(null);
  }

  function handleDragOver(e: React.DragEvent, targetId: string | 'unorganized') {
    const isResourceDrag = e.dataTransfer.types.includes('application/resource-id');
    const ev = draggingEventRef.current;
    if (!ev && !isResourceDrag) return;
    if (ev) {
      const currentGroupId = ev.group_id ?? 'unorganized';
      if (currentGroupId === targetId) return;
    }
    e.preventDefault();
    setDragOverGroupId(targetId);
  }

  function handleGroupDrop(e: React.DragEvent, targetGroupId: string | null) {
    const resourceId = e.dataTransfer.getData('application/resource-id');
    if (resourceId) {
      window.calendarAPI.moveResource(resourceId, { group_id: targetGroupId, event_id: null, parent_id: null }).then(reloadResources);
      setDragOverGroupId(null);
      return;
    }
    const ev = draggingEventRef.current;
    if (!ev) return;
    onReassign(ev.id, targetGroupId);
    clearDraggingEvent();
    setDragOverGroupId(null);
  }

  function handleDragEnd() {
    clearDraggingEvent();
    setDragOverGroupId(null);
  }

  function confirmDelete(deleteEvents: boolean) {
    if (!deletingGroup) return;
    onDeleteGroup(deletingGroup.id, deleteEvents);
    setDeletingGroup(null);
  }

  const deletingGroupEventCount = deletingGroup
    ? (eventsByGroup.get(deletingGroup.id)?.length ?? 0)
    : 0;

  const eventResourcesMapForGroup = useCallback((groupEvents: CalendarEvent[]) => {
    const m = new Map<string, CalendarResource[]>();
    for (const ev of groupEvents) {
      const evRes = resourcesByEvent.get(ev.id);
      if (evRes) m.set(ev.id, evRes);
    }
    return m;
  }, [resourcesByEvent]);

  const openModal = useCallback((state: ResourceModalState) => setResModal(state), []);
  const openContextMenu = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setContextMenu({ x, y, items });
  }, []);



  return (
    <>
      <div className="overviewPanel" onDragEnd={handleDragEnd}>
        <div className="overviewPanelHeader">
          <span className="overviewPanelTitle">Plan</span>
          <button
            className="overviewNewBtn"
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              setResModal({ mode: 'create', type: null, resource: null, scopeProps: { group_id: null, event_id: null }, scopeLabel: 'Workspace', anchorX: rect.right, anchorY: rect.bottom + 4 });
            }}
            title="Create new…"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            New
          </button>
        </div>
        <div className="overviewList">
          {groups.map(group => {
            const groupEvents = eventsByGroup.get(group.id) ?? [];
            return (
              <GroupRow
                key={group.id}
                group={group}
                events={groupEvents}
                dependencies={dependencies}
                groupResources={resourcesByGroup.get(group.id) ?? []}
                eventResourcesMap={eventResourcesMapForGroup(groupEvents)}
                isDragOver={dragOverGroupId === group.id}
                onEventClick={onEventClick}
                onEventDragStart={startDraggingEvent}
                onDragOver={e => handleDragOver(e, group.id)}
                onDragLeave={() => setDragOverGroupId(null)}
                onDrop={e => handleGroupDrop(e, group.id)}
                onDeleteClick={() => setDeletingGroup(group)}
                onRename={newName => onRenameGroup(group.id, newName)}
                onResourceMutated={reloadResources}
                onOpenModal={openModal}
                onOpenContextMenu={openContextMenu}
              />
            );
          })}
          <div
            className={`overviewUnorganizedSection${dragOverGroupId === 'unorganized' ? ' overviewGroupDragOver' : ''}`}
            onDragOver={e => handleDragOver(e, 'unorganized')}
            onDragLeave={() => setDragOverGroupId(null)}
            onDrop={e => handleGroupDrop(e, null)}
          >
            <div className="overviewSectionLabel">Unorganized</div>
            {unplannedEvents.map(event => (
              <EventItem
                key={event.id}
                event={event}
                groupColor="#C8C5BE"
                resources={resourcesByEvent.get(event.id) ?? []}
                isLinked={false}
                onEventClick={onEventClick}
                onEventDragStart={startDraggingEvent}
                onResourceMutated={reloadResources}
                onOpenModal={openModal}
                onOpenContextMenu={openContextMenu}
              />
            ))}
            <ResourceSection
              scope={{ type: 'floating' }}
              resources={floatingResources}
              indent={8}
              onMutated={reloadResources}
              onOpenModal={openModal}
              onOpenContextMenu={openContextMenu}
            />
          </div>
        </div>

      </div>

      {resModal && (
        <ResourceEditModal
          state={resModal}
          groups={groups}
          onClose={() => setResModal(null)}
          onMutated={reloadResources}
          onGroupCreated={onGroupCreated}
          onEventCreated={onEventCreated}
        />
      )}

      {contextMenu && (
        <ContextMenu
          {...contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {deletingGroup && (
        <div className="deleteGroupOverlay" onClick={() => setDeletingGroup(null)}>
          <div className="deleteGroupDialog" onClick={e => e.stopPropagation()}>
            <p className="deleteGroupTitle">Remove "{deletingGroup.name}"?</p>
            <p className="deleteGroupBody">
              {deletingGroupEventCount > 0
                ? `This group has ${deletingGroupEventCount} event${deletingGroupEventCount === 1 ? '' : 's'}.`
                : 'This group has no events.'}
            </p>
            <div className="deleteGroupActions">
              {deletingGroupEventCount > 0 && (
                <button className="deleteGroupActionDanger" onClick={() => confirmDelete(true)}>
                  Delete group and events
                </button>
              )}
              <button className="deleteGroupActionKeep" onClick={() => confirmDelete(false)}>
                {deletingGroupEventCount > 0 ? 'Remove group, keep events' : 'Remove group'}
              </button>
              <button className="deleteGroupActionCancel" onClick={() => setDeletingGroup(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
