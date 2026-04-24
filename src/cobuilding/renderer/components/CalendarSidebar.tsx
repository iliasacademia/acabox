import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { PLAN_COLORS } from '../calendarColors';
import type { CalendarPlan, CalendarEvent, EventDependency, CalendarResource, CreateResourceData } from '../../shared/types';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function planDateRange(events: CalendarEvent[]): string | null {
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
  | { type: 'plan'; id: string }
  | { type: 'event'; id: string }
  | { type: 'floating' };

interface LinkFormState {
  url: string;
  title: string;
}

// ---- ResourceSection ----

interface ResourceSectionProps {
  scope: ResourceScope;
  resources: CalendarResource[];
  insideGroupEvents?: boolean;
  onMutated: () => void;
}

function ResourceSection({ scope, resources, insideGroupEvents, onMutated }: ResourceSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [addingActive, setAddingActive] = useState(false);
  const [linkForm, setLinkForm] = useState<LinkFormState | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [folderExpanded, setFolderExpanded] = useState<Set<string>>(new Set());
  const [dragOverTarget, setDragOverTarget] = useState<string | 'root' | null>(null);

  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => { if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current); };
  }, []);

  const flushNote = useCallback(async () => {
    if (noteSaveTimer.current && noteIdRef.current) {
      clearTimeout(noteSaveTimer.current);
      noteSaveTimer.current = null;
      await window.calendarAPI.updateResource(noteIdRef.current, { note_content: editingNoteContent });
      onMutated();
    }
  }, [editingNoteContent, onMutated]);

  const scopeProps: Pick<CreateResourceData, 'plan_id' | 'event_id'> = {
    plan_id: scope.type === 'plan' ? scope.id : null,
    event_id: scope.type === 'event' ? scope.id : null,
  };

  const handleDelete = async (id: string) => {
    await window.calendarAPI.deleteResource(id);
    onMutated();
  };

  const handleAddFile = async () => {
    const paths = await window.calendarAPI.pickResourceFile();
    if (!paths || paths.length === 0) return;
    await Promise.all(paths.map(fp =>
      window.calendarAPI.createResource({ type: 'file', ...scopeProps, file_path: fp, title: basename(fp) })
    ));
    setAddingActive(false);
    setExpanded(true);
    onMutated();
  };

  const handleSaveLink = async () => {
    if (!linkForm?.url.trim()) return;
    await window.calendarAPI.createResource({
      type: 'link',
      ...scopeProps,
      url: linkForm.url.trim(),
      title: linkForm.title.trim() || linkForm.url.trim(),
    });
    setLinkForm(null);
    setExpanded(true);
    onMutated();
  };

  const handleAddNote = async () => {
    const created = await window.calendarAPI.createResource({
      type: 'note', ...scopeProps, note_content: '', title: '',
    });
    setAddingActive(false);
    setExpanded(true);
    noteIdRef.current = created.id;
    setEditingNoteId(created.id);
    setEditingNoteContent('');
    onMutated();
  };

  const handleAddFolder = async () => {
    const created = await window.calendarAPI.createResource({
      type: 'folder', ...scopeProps, title: 'New Folder',
    });
    setAddingActive(false);
    setExpanded(true);
    setFolderExpanded(prev => new Set(prev).add(created.id));
    setEditingTitleId(created.id);
    setEditingTitleValue('New Folder');
    onMutated();
  };

  const handleNoteClick = async (r: CalendarResource) => {
    if (editingNoteId === r.id) return;
    await flushNote();
    noteIdRef.current = r.id;
    setEditingNoteId(r.id);
    setEditingNoteContent(r.note_content ?? '');
  };

  const handleNoteBlur = async () => {
    await flushNote();
    setEditingNoteId(null);
    noteIdRef.current = null;
  };

  const handleTitleSave = async (id: string) => {
    await window.calendarAPI.updateResource(id, { title: editingTitleValue });
    setEditingTitleId(null);
    onMutated();
  };

  const handleResourceClick = (r: CalendarResource) => {
    if (r.type === 'file' && r.file_path) window.calendarAPI.openResourceFile(r.file_path);
    else if (r.type === 'link' && r.url) window.calendarAPI.openResourceUrl(r.url);
    else if (r.type === 'note') handleNoteClick(r);
  };

  const handleContextMenu = (e: React.MouseEvent, r: CalendarResource) => {
    if (r.type !== 'file' || !r.file_path) return;
    e.preventDefault();
    window.calendarAPI.revealResourceFile(r.file_path);
  };

  const toggleFolder = (id: string) => {
    setFolderExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const handleDrop = async (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const resourceId = e.dataTransfer.getData('application/resource-id');
    if (!resourceId || resourceId === targetFolderId) { setDragOverTarget(null); return; }
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
    const isEditingNote = editingNoteId === r.id;
    const indent = 10 + depth * 14;

    return (
      <React.Fragment key={r.id}>
        <button
          className={`overviewResourceRow${isFolder ? ' overviewFolderRow' : ''}${isDragOver ? ' overviewResourceDropTarget' : ''}`}
          style={{ paddingLeft: `${indent}px` }}
          draggable
          onDragStart={e => {
            e.dataTransfer.setData('application/resource-id', r.id);
            e.stopPropagation();
          }}
          onDragOver={e => {
            if (!e.dataTransfer.types.includes('application/resource-id')) return;
            e.preventDefault();
            e.stopPropagation();
            if (isFolder && dragOverTarget !== r.id) setDragOverTarget(r.id);
          }}
          onDragLeave={() => {
            if (dragOverTarget === r.id) setDragOverTarget(null);
          }}
          onDrop={e => { if (isFolder) handleDrop(e, r.id); }}
          onClick={e => {
            e.stopPropagation();
            if (isFolder) toggleFolder(r.id);
            else handleResourceClick(r);
          }}
          onContextMenu={e => handleContextMenu(e, r)}
        >
          {isFolder ? (
            <svg
              className={`overviewChevron${isFolderOpen ? ' overviewChevronOpen' : ''}`}
              width="10" height="10" viewBox="0 0 10 10" fill="none"
            >
              <path d="M3.5 2.5L6 5L3.5 7.5" stroke="#9B9B95" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
          >
            ×
          </button>
        </button>
        {isEditingNote && (
          <div className="overviewResourceNoteEditor" style={{ paddingLeft: `${indent + 22}px` }}>
            <textarea
              className="overviewResourceNoteTextarea"
              autoFocus
              value={editingNoteContent}
              onChange={e => {
                const val = e.target.value;
                setEditingNoteContent(val);
                if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
                noteSaveTimer.current = setTimeout(async () => {
                  noteSaveTimer.current = null;
                  await window.calendarAPI.updateResource(r.id, { note_content: val });
                  onMutated();
                }, 500);
              }}
              onBlur={handleNoteBlur}
            />
          </div>
        )}
        {isFolderOpen && node.children.length > 0 && (
          <div className="overviewFolderChildren">
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </React.Fragment>
    );
  }

  const cls = insideGroupEvents ? 'overviewGroupEvents' : '';

  return (
    <div className={`overviewResourcesSection${cls ? ' ' + cls : ''}`}>
      <button
        className={`overviewResourcesToggle${dragOverTarget === 'root' ? ' overviewResourceDropTarget' : ''}`}
        onClick={() => setExpanded(v => !v)}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes('application/resource-id')) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOverTarget('root');
        }}
        onDragLeave={() => setDragOverTarget(null)}
        onDrop={e => handleDrop(e, null)}
      >
        <svg
          className={`overviewChevron${expanded ? ' overviewChevronOpen' : ''}`}
          width="10" height="10" viewBox="0 0 10 10" fill="none"
        >
          <path d="M3.5 2.5L6 5L3.5 7.5" stroke="#9B9B95" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="overviewResourcesLabel">Files &amp; Notes</span>
        {resources.length > 0 && (
          <span className="overviewResourcesCount">{resources.length}</span>
        )}
        <button
          className="overviewResourcesAddBtn"
          onClick={e => { e.stopPropagation(); setAddingActive(v => !v); setExpanded(true); }}
          title="Add file, link, note, or folder"
        >
          +
        </button>
      </button>

      {expanded && (
        <div className="overviewResourceList">
          {tree.map(node => renderNode(node, 0))}

          {addingActive && (
            <div className="overviewResourceAddAffordance">
              <button className="overviewResourceAddTypeBtn" onClick={handleAddFile}>File</button>
              <button className="overviewResourceAddTypeBtn" onClick={() => { setLinkForm({ url: '', title: '' }); setAddingActive(false); }}>Link</button>
              <button className="overviewResourceAddTypeBtn" onClick={handleAddNote}>Note</button>
              <button className="overviewResourceAddTypeBtn" onClick={handleAddFolder}>Folder</button>
            </div>
          )}

          {linkForm && (
            <div className="overviewResourceLinkForm">
              <input
                className="overviewResourceLinkInput"
                placeholder="https://..."
                value={linkForm.url}
                autoFocus
                onChange={e => setLinkForm(prev => prev ? { ...prev, url: e.target.value } : null)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveLink(); if (e.key === 'Escape') setLinkForm(null); }}
              />
              <input
                className="overviewResourceLinkInput"
                placeholder="Title (optional)"
                value={linkForm.title}
                onChange={e => setLinkForm(prev => prev ? { ...prev, title: e.target.value } : null)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveLink(); if (e.key === 'Escape') setLinkForm(null); }}
              />
              <div className="overviewResourceLinkActions">
                <button className="overviewResourceLinkSave" onClick={handleSaveLink}>Add</button>
                <button className="overviewResourceLinkCancel" onClick={() => setLinkForm(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- EventItem ----
// Event row with per-event file badge and expandable ResourceSection

interface EventItemProps {
  event: CalendarEvent;
  planColor: string;
  resources: CalendarResource[];
  isLinked: boolean;
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onEventDragStart: (event: CalendarEvent) => void;
  onResourceMutated: () => void;
}

function EventItem({ event, planColor, resources, isLinked, onEventClick, onEventDragStart, onResourceMutated }: EventItemProps) {
  const [resourcesExpanded, setResourcesExpanded] = useState(false);

  return (
    <>
      <div className="overviewEventRowWrap">
        <button
          className="overviewEventRow"
          draggable
          onDragStart={() => onEventDragStart(event)}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            onEventClick?.(event, r.right, r.top + r.height / 2);
          }}
        >
          <span
            className={`overviewEventDot${event.status !== 'active' ? ' overviewEventDotInactive' : ''}`}
            style={event.status === 'active' ? { backgroundColor: planColor } : { borderColor: planColor }}
          />
          <span className="overviewEventName">{event.name}</span>
          <span className="overviewEventDate">{formatDateShort(event.start_at)}</span>
        </button>
        <button
          className={`overviewEventExpandBtn${resourcesExpanded ? ' overviewEventExpandBtnOpen' : ''}${resources.length > 0 ? ' overviewEventExpandBtnHasFiles' : ''}`}
          onClick={() => setResourcesExpanded(v => !v)}
          title={resources.length > 0 ? `${resources.length} file${resources.length === 1 ? '' : 's'}` : 'Files & notes'}
        >
          {resources.length > 0 && (
            <span className="overviewEventFilesCount">{resources.length}</span>
          )}
          <svg className="overviewEventExpandChevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3.5 2.5L6 5L3.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
      {resourcesExpanded && (
        <ResourceSection
          scope={{ type: 'event', id: event.id }}
          resources={resources}
          insideGroupEvents
          onMutated={onResourceMutated}
        />
      )}
      {isLinked && <div className="overviewDepConnector" style={{ borderColor: planColor }} />}
    </>
  );
}

// ---- PlanRow ----

interface PlanRowProps {
  plan: CalendarPlan;
  events: CalendarEvent[];
  dependencies: EventDependency[];
  planResources: CalendarResource[];
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
}

function PlanRow({ plan, events, dependencies, planResources, eventResourcesMap, isDragOver, onEventClick, onEventDragStart, onDragOver, onDragLeave, onDrop, onDeleteClick, onRename, onResourceMutated }: PlanRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const dateRange = useMemo(() => planDateRange(events), [events]);

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setRenameValue(plan.name);
    setRenaming(true);
    setTimeout(() => { renameRef.current?.select(); }, 0);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed && trimmed !== plan.name) await onRename(trimmed);
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

  return (
    <div
      className={`overviewGroup${isDragOver ? ' overviewGroupDragOver' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="overviewGroupHeaderWrap">
        <button
          className="overviewGroupHeader"
          onClick={() => { if (!renaming) setExpanded(prev => !prev); }}
        >
          <svg
            className={`overviewChevron${expanded ? ' overviewChevronOpen' : ''}`}
            width="10" height="10" viewBox="0 0 10 10" fill="none"
          >
            <path d="M3.5 2.5L6 5L3.5 7.5" stroke="#9B9B95" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="overviewGroupAccent" style={{ backgroundColor: plan.color }} />
          <div className="overviewGroupMeta">
            {renaming ? (
              <input
                ref={renameRef}
                className="overviewGroupRenameInput"
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
              <span className="overviewGroupName" onDoubleClick={startRename}>{plan.name}</span>
            )}
            {!renaming && dateRange && <span className="overviewGroupRange">{dateRange}</span>}
          </div>
        </button>
        <button
          className="overviewGroupDeleteBtn"
          onClick={e => { e.stopPropagation(); onDeleteClick(); }}
          title="Remove group"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="overviewGroupEvents">
          {events.map((event, i) => (
            <EventItem
              key={event.id}
              event={event}
              planColor={plan.color}
              resources={eventResourcesMap.get(event.id) ?? []}
              isLinked={i < events.length - 1 && isLinkedToNext(event, events[i + 1])}
              onEventClick={onEventClick}
              onEventDragStart={onEventDragStart}
              onResourceMutated={onResourceMutated}
            />
          ))}
          <ResourceSection
            scope={{ type: 'plan', id: plan.id }}
            resources={planResources}
            insideGroupEvents
            onMutated={onResourceMutated}
          />
        </div>
      )}
    </div>
  );
}

// ---- NewGroupForm ----

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
  plans: CalendarPlan[];
  allEvents: CalendarEvent[];
  dependencies: EventDependency[];
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onReassign: (eventId: string, newPlanId: string | null) => void;
  onDeletePlan: (planId: string, deleteEvents: boolean) => void;
  onCreateGroup: (name: string, color: string) => Promise<void>;
  onRenamePlan: (planId: string, newName: string) => Promise<void>;
}

export function CalendarSidebar({ plans, allEvents, dependencies, onEventClick, onReassign, onDeletePlan, onCreateGroup, onRenamePlan }: CalendarSidebarProps) {
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);
  const [dragOverPlanId, setDragOverPlanId] = useState<string | 'unorganized' | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<CalendarPlan | null>(null);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [resources, setResources] = useState<CalendarResource[]>([]);

  const reloadResources = useCallback(async () => {
    const all = await window.calendarAPI.listResources({});
    setResources(all);
  }, []);

  useEffect(() => { reloadResources(); }, [reloadResources]);

  // Plan-level resources: plan_id set, event_id null
  const resourcesByPlan = useMemo(() => {
    const m = new Map<string, CalendarResource[]>();
    for (const r of resources) {
      if (r.plan_id && !r.event_id) {
        const arr = m.get(r.plan_id) ?? [];
        arr.push(r);
        m.set(r.plan_id, arr);
      }
    }
    return m;
  }, [resources]);

  // Event-level resources: event_id set
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
    () => resources.filter(r => !r.plan_id && !r.event_id),
    [resources]
  );

  const eventsByPlan = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of allEvents) {
      if (event.plan_id) {
        const arr = map.get(event.plan_id) ?? [];
        arr.push(event);
        map.set(event.plan_id, arr);
      }
    }
    for (const [id, arr] of map) {
      map.set(id, arr.slice().sort((a, b) => a.start_at.localeCompare(b.start_at)));
    }
    return map;
  }, [allEvents]);

  const unplannedEvents = useMemo(
    () => allEvents.filter(e => !e.plan_id && e.status !== 'inactive_hidden')
      .sort((a, b) => a.start_at.localeCompare(b.start_at)),
    [allEvents],
  );

  function handleDragOver(e: React.DragEvent, targetId: string | 'unorganized') {
    if (!draggingEvent) return;
    const currentPlanId = draggingEvent.plan_id ?? 'unorganized';
    if (currentPlanId === targetId) return;
    e.preventDefault();
    setDragOverPlanId(targetId);
  }

  function handleDrop(targetPlanId: string | null) {
    if (!draggingEvent) return;
    onReassign(draggingEvent.id, targetPlanId);
    setDraggingEvent(null);
    setDragOverPlanId(null);
  }

  function handleDragEnd() {
    setDraggingEvent(null);
    setDragOverPlanId(null);
  }

  function confirmDelete(deleteEvents: boolean) {
    if (!deletingPlan) return;
    onDeletePlan(deletingPlan.id, deleteEvents);
    setDeletingPlan(null);
  }

  const deletingPlanEventCount = deletingPlan
    ? (eventsByPlan.get(deletingPlan.id)?.length ?? 0)
    : 0;

  const eventResourcesMapForPlan = useCallback((planEvents: CalendarEvent[]) => {
    const m = new Map<string, CalendarResource[]>();
    for (const ev of planEvents) {
      const evRes = resourcesByEvent.get(ev.id);
      if (evRes) m.set(ev.id, evRes);
    }
    return m;
  }, [resourcesByEvent]);

  return (
    <>
      <div className="overviewPanel" onDragEnd={handleDragEnd}>
        <div className="overviewList">
          {plans.map(plan => {
            const planEvents = eventsByPlan.get(plan.id) ?? [];
            return (
              <PlanRow
                key={plan.id}
                plan={plan}
                events={planEvents}
                dependencies={dependencies}
                planResources={resourcesByPlan.get(plan.id) ?? []}
                eventResourcesMap={eventResourcesMapForPlan(planEvents)}
                isDragOver={dragOverPlanId === plan.id}
                onEventClick={onEventClick}
                onEventDragStart={setDraggingEvent}
                onDragOver={e => handleDragOver(e, plan.id)}
                onDragLeave={() => setDragOverPlanId(null)}
                onDrop={() => handleDrop(plan.id)}
                onDeleteClick={() => setDeletingPlan(plan)}
                onRename={newName => onRenamePlan(plan.id, newName)}
                onResourceMutated={reloadResources}
              />
            );
          })}
          {showNewGroupForm && (
            <NewGroupForm
              onSubmit={async (name, color) => {
                await onCreateGroup(name, color);
                setShowNewGroupForm(false);
              }}
              onCancel={() => setShowNewGroupForm(false)}
            />
          )}
          <div
            className={`overviewUnorganizedSection${dragOverPlanId === 'unorganized' ? ' overviewGroupDragOver' : ''}`}
            onDragOver={e => handleDragOver(e, 'unorganized')}
            onDragLeave={() => setDragOverPlanId(null)}
            onDrop={() => handleDrop(null)}
          >
            <div className="overviewSectionLabel">Unorganized</div>
            {unplannedEvents.map(event => (
              <EventItem
                key={event.id}
                event={event}
                planColor="#C8C5BE"
                resources={resourcesByEvent.get(event.id) ?? []}
                isLinked={false}
                onEventClick={onEventClick}
                onEventDragStart={setDraggingEvent}
                onResourceMutated={reloadResources}
              />
            ))}
            <ResourceSection
              scope={{ type: 'floating' }}
              resources={floatingResources}
              onMutated={reloadResources}
            />
          </div>
        </div>
        <button
          className="overviewAddGroupBtn"
          onClick={() => setShowNewGroupForm(v => !v)}
          title="New group"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {deletingPlan && (
        <div className="deletePlanOverlay" onClick={() => setDeletingPlan(null)}>
          <div className="deletePlanDialog" onClick={e => e.stopPropagation()}>
            <p className="deletePlanTitle">Remove "{deletingPlan.name}"?</p>
            <p className="deletePlanBody">
              {deletingPlanEventCount > 0
                ? `This group has ${deletingPlanEventCount} event${deletingPlanEventCount === 1 ? '' : 's'}.`
                : 'This group has no events.'}
            </p>
            <div className="deletePlanActions">
              {deletingPlanEventCount > 0 && (
                <button className="deletePlanActionDanger" onClick={() => confirmDelete(true)}>
                  Delete group and events
                </button>
              )}
              <button className="deletePlanActionKeep" onClick={() => confirmDelete(false)}>
                {deletingPlanEventCount > 0 ? 'Remove group, keep events' : 'Remove group'}
              </button>
              <button className="deletePlanActionCancel" onClick={() => setDeletingPlan(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
