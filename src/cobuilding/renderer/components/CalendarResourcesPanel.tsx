import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, CalendarPlan, CalendarResource, CreateResourceData } from '../../shared/types';
import './CalendarResourcesPanel.css';

interface CalendarResourcesPanelProps {
  plans: CalendarPlan[];
  allEvents: CalendarEvent[];
}

type Scope =
  | { type: 'plan'; id: string }
  | { type: 'event'; id: string }
  | { type: 'floating' };

interface LinkFormState {
  scope: Scope;
  url: string;
  title: string;
}

function resourceIcon(type: CalendarResource['type']): string {
  if (type === 'file') return '📄';
  if (type === 'link') return '🔗';
  return '📝';
}

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

function displayTitle(r: CalendarResource): string {
  if (r.title) return r.title;
  if (r.type === 'file' && r.file_path) return basename(r.file_path);
  if (r.type === 'link' && r.url) return r.url;
  return 'Untitled note';
}

export function CalendarResourcesPanel({ plans, allEvents }: CalendarResourcesPanelProps) {
  const [resources, setResources] = useState<CalendarResource[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['__floating__']));
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [addingScope, setAddingScope] = useState<Scope | null>(null);
  const [linkForm, setLinkForm] = useState<LinkFormState | null>(null);

  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteIdRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const all = await window.calendarAPI.listResources({});
    setResources(all);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // flush pending note save on unmount
  useEffect(() => {
    return () => {
      if (noteSaveTimerRef.current) {
        clearTimeout(noteSaveTimerRef.current);
        noteSaveTimerRef.current = null;
      }
    };
  }, []);

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDeleteResource = async (id: string) => {
    setResources(prev => prev.filter(r => r.id !== id));
    if (editingNoteId === id) setEditingNoteId(null);
    await window.calendarAPI.deleteResource(id);
  };

  const handleAddFile = async (scope: Scope) => {
    const paths = await window.calendarAPI.pickResourceFile();
    if (!paths || paths.length === 0) return;
    const data: CreateResourceData = {
      type: 'file',
      plan_id: scope.type === 'plan' ? scope.id : null,
      event_id: scope.type === 'event' ? scope.id : null,
    };
    const created = await Promise.all(
      paths.map(fp =>
        window.calendarAPI.createResource({ ...data, file_path: fp, title: basename(fp) })
      )
    );
    setResources(prev => [...prev, ...created]);
    // ensure the section is expanded
    if (scope.type === 'plan') setExpandedSections(prev => new Set([...prev, scope.id]));
    if (scope.type === 'floating') setExpandedSections(prev => new Set([...prev, '__floating__']));
    setAddingScope(null);
  };

  const handleStartLinkForm = (scope: Scope) => {
    setLinkForm({ scope, url: '', title: '' });
    setAddingScope(null);
  };

  const handleSaveLink = async () => {
    if (!linkForm || !linkForm.url.trim()) return;
    const scope = linkForm.scope;
    const created = await window.calendarAPI.createResource({
      type: 'link',
      url: linkForm.url.trim(),
      title: linkForm.title.trim() || linkForm.url.trim(),
      plan_id: scope.type === 'plan' ? scope.id : null,
      event_id: scope.type === 'event' ? scope.id : null,
    });
    setResources(prev => [...prev, created]);
    if (scope.type === 'plan') setExpandedSections(prev => new Set([...prev, scope.id]));
    if (scope.type === 'floating') setExpandedSections(prev => new Set([...prev, '__floating__']));
    setLinkForm(null);
  };

  const handleAddNote = async (scope: Scope) => {
    const created = await window.calendarAPI.createResource({
      type: 'note',
      note_content: '',
      title: '',
      plan_id: scope.type === 'plan' ? scope.id : null,
      event_id: scope.type === 'event' ? scope.id : null,
    });
    setResources(prev => [...prev, created]);
    if (scope.type === 'plan') setExpandedSections(prev => new Set([...prev, scope.id]));
    if (scope.type === 'floating') setExpandedSections(prev => new Set([...prev, '__floating__']));
    noteIdRef.current = created.id;
    setEditingNoteId(created.id);
    setEditingNoteContent('');
    setAddingScope(null);
  };

  const scheduleNoteSave = (id: string, content: string) => {
    if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
    noteSaveTimerRef.current = setTimeout(async () => {
      noteSaveTimerRef.current = null;
      await window.calendarAPI.updateResource(id, { note_content: content });
      setResources(prev => prev.map(r => r.id === id ? { ...r, note_content: content } : r));
    }, 500);
  };

  const flushNoteSave = async () => {
    if (noteSaveTimerRef.current && noteIdRef.current) {
      clearTimeout(noteSaveTimerRef.current);
      noteSaveTimerRef.current = null;
      await window.calendarAPI.updateResource(noteIdRef.current, { note_content: editingNoteContent });
      setResources(prev => prev.map(r => r.id === noteIdRef.current ? { ...r, note_content: editingNoteContent } : r));
    }
  };

  const handleNoteClick = async (r: CalendarResource) => {
    if (editingNoteId === r.id) return;
    await flushNoteSave();
    noteIdRef.current = r.id;
    setEditingNoteId(r.id);
    setEditingNoteContent(r.note_content ?? '');
  };

  const handleNoteBlur = async () => {
    await flushNoteSave();
    setEditingNoteId(null);
    noteIdRef.current = null;
  };

  const handleTitleDoubleClick = (r: CalendarResource) => {
    setEditingTitleId(r.id);
    setEditingTitleValue(r.title || (r.type === 'file' && r.file_path ? basename(r.file_path) : ''));
  };

  const handleTitleSave = async (id: string) => {
    const updated = await window.calendarAPI.updateResource(id, { title: editingTitleValue });
    if (updated) setResources(prev => prev.map(r => r.id === id ? updated : r));
    setEditingTitleId(null);
  };

  const handleResourceClick = (r: CalendarResource) => {
    if (r.type === 'file' && r.file_path) {
      window.calendarAPI.openResourceFile(r.file_path);
    } else if (r.type === 'link' && r.url) {
      window.calendarAPI.openResourceUrl(r.url);
    } else if (r.type === 'note') {
      handleNoteClick(r);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, r: CalendarResource) => {
    if (r.type !== 'file' || !r.file_path) return;
    e.preventDefault();
    window.calendarAPI.revealResourceFile(r.file_path);
  };

  const isScopeMatch = (scope: Scope): boolean => {
    if (!addingScope) return false;
    if (addingScope.type !== scope.type) return false;
    if (scope.type === 'floating') return true;
    return 'id' in addingScope && 'id' in scope && addingScope.id === (scope as { type: string; id: string }).id;
  };

  const renderAddAffordance = (scope: Scope, indentClass?: string) => {
    if (!isScopeMatch(scope)) return null;
    const cls = `resAddAffordance${indentClass ? ' ' + indentClass : ''}`;
    return (
      <div className={cls}>
        <button className="resAddTypeBtn" onClick={() => handleAddFile(scope)}>📄 File</button>
        <button className="resAddTypeBtn" onClick={() => handleStartLinkForm(scope)}>🔗 Link</button>
        <button className="resAddTypeBtn" onClick={() => handleAddNote(scope)}>📝 Note</button>
      </div>
    );
  };

  const renderLinkForm = (scope: Scope, indentClass?: string) => {
    if (!linkForm) return null;
    const isSameScope =
      linkForm.scope.type === scope.type &&
      (scope.type === 'floating' ||
        ('id' in linkForm.scope && 'id' in scope && linkForm.scope.id === scope.id));
    if (!isSameScope) return null;
    const cls = `resLinkForm${indentClass ? ' ' + indentClass : ''}`;
    return (
      <div className={cls}>
        <input
          className="resLinkInput"
          placeholder="https://..."
          value={linkForm.url}
          autoFocus
          onChange={e => setLinkForm(prev => prev ? { ...prev, url: e.target.value } : null)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSaveLink();
            if (e.key === 'Escape') setLinkForm(null);
          }}
        />
        <input
          className="resLinkInput"
          placeholder="Title (optional)"
          value={linkForm.title}
          onChange={e => setLinkForm(prev => prev ? { ...prev, title: e.target.value } : null)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSaveLink();
            if (e.key === 'Escape') setLinkForm(null);
          }}
        />
        <div className="resLinkFormActions">
          <button className="resLinkSaveBtn" onClick={handleSaveLink}>Add</button>
          <button className="resLinkCancelBtn" onClick={() => setLinkForm(null)}>Cancel</button>
        </div>
      </div>
    );
  };

  const renderResourceRow = (r: CalendarResource, indentClass?: string) => {
    const isEditingNote = editingNoteId === r.id;
    const isEditingTitle = editingTitleId === r.id;
    const noteIndent = indentClass === 'resRowIndented' ? 'resNoteEditorIndented'
      : indentClass === 'resRowDeepIndented' ? 'resNoteEditorDeepIndented' : '';

    return (
      <div key={r.id} className="resRowContainer">
        <button
          className={`resRow${indentClass ? ' ' + indentClass : ''}`}
          onClick={() => r.type !== 'note' ? handleResourceClick(r) : handleNoteClick(r)}
          onContextMenu={e => handleContextMenu(e, r)}
        >
          <span className="resTypeIcon">{resourceIcon(r.type)}</span>
          {r.ai_generated === 1 && <span className="resAiSparkle" title="AI-suggested">✦</span>}
          {isEditingTitle ? (
            <input
              className="resRowTitleInput"
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
              className="resRowTitle"
              onDoubleClick={e => { e.stopPropagation(); handleTitleDoubleClick(r); }}
            >
              {displayTitle(r)}
            </span>
          )}
          <button
            className="resDeleteBtn"
            onClick={e => { e.stopPropagation(); handleDeleteResource(r.id); }}
            title="Remove"
          >
            ×
          </button>
        </button>
        {isEditingNote && (
          <div className={`resNoteEditor${noteIndent ? ' ' + noteIndent : ''}`}>
            <textarea
              className="resNoteTextarea"
              autoFocus
              value={editingNoteContent}
              onChange={e => {
                setEditingNoteContent(e.target.value);
                scheduleNoteSave(r.id, e.target.value);
              }}
              onBlur={handleNoteBlur}
            />
          </div>
        )}
      </div>
    );
  };

  // Group resources
  const byPlan = new Map<string, CalendarResource[]>();
  const byEvent = new Map<string, CalendarResource[]>();
  const floating: CalendarResource[] = [];

  for (const r of resources) {
    if (r.plan_id) {
      const arr = byPlan.get(r.plan_id) ?? [];
      arr.push(r);
      byPlan.set(r.plan_id, arr);
    } else if (r.event_id) {
      const arr = byEvent.get(r.event_id) ?? [];
      arr.push(r);
      byEvent.set(r.event_id, arr);
    } else {
      floating.push(r);
    }
  }

  // Events with resources that aren't directly under a plan
  const eventsWithFloatingResources = allEvents.filter(
    e => byEvent.has(e.id) && !e.plan_id
  );

  const hasAnything =
    resources.length > 0 ||
    addingScope !== null ||
    linkForm !== null;


  return (
    <div className="resPanel">
      <div className="resHeader">
        <span className="resHeaderTitle">Resources</span>
        <button
          className="resHeaderAddBtn"
          title="Add resource"
          onClick={() => setAddingScope(s => s?.type === 'floating' ? null : { type: 'floating' })}
        >
          +
        </button>
      </div>

      <div className="resList">
        {!hasAnything && (
          <div className="resEmptyState">
            Drop files, links, and notes<br />here to organize your day.
          </div>
        )}

        {/* Plan sections */}
        {plans.map(plan => {
          const planResources = byPlan.get(plan.id) ?? [];
          // events under this plan that have resources
          const planEvents = allEvents.filter(e => e.plan_id === plan.id && byEvent.has(e.id));
          const isAddingHere = isScopeMatch({ type: 'plan', id: plan.id });
          const hasContent = planResources.length > 0 || planEvents.length > 0 || isAddingHere || (linkForm && linkForm.scope.type === 'plan' && linkForm.scope.id === plan.id);

          if (!hasContent) return null;

          const expanded = expandedSections.has(plan.id);
          return (
            <div key={plan.id}>
              <div className="resSectionHeader" onClick={() => toggleSection(plan.id)}>
                <span className="resSectionChevron">{expanded ? '▾' : '▸'}</span>
                <span className="resSectionDot" style={{ backgroundColor: plan.color }} />
                <span className="resSectionName">{plan.name}</span>
                <button
                  className="resSectionAddBtn"
                  title="Add resource to plan"
                  onClick={e => {
                    e.stopPropagation();
                    setAddingScope(s => isScopeMatch({ type: 'plan', id: plan.id }) ? null : { type: 'plan', id: plan.id });
                    setExpandedSections(prev => new Set([...prev, plan.id]));
                  }}
                >
                  +
                </button>
              </div>
              {expanded && (
                <>
                  {planResources.map(r => renderResourceRow(r, 'resRowIndented'))}
                  {renderAddAffordance({ type: 'plan', id: plan.id }, 'resAddAffordanceIndented')}
                  {renderLinkForm({ type: 'plan', id: plan.id }, 'resLinkFormIndented')}
                  {planEvents.map(event => {
                    const eventResources = byEvent.get(event.id) ?? [];
                    const eventKey = `event-${event.id}`;
                    const eventExpanded = expandedSections.has(eventKey);
                    return (
                      <div key={event.id}>
                        <div className="resEventHeader" onClick={() => toggleSection(eventKey)}>
                          <span className="resSectionChevron" style={{ marginLeft: 8 }}>{eventExpanded ? '▾' : '▸'}</span>
                          <span className="resEventName">{event.name}</span>
                          <button
                            className="resEventAddBtn"
                            onClick={e => {
                              e.stopPropagation();
                              setAddingScope(s => isScopeMatch({ type: 'event', id: event.id }) ? null : { type: 'event', id: event.id });
                              setExpandedSections(prev => new Set([...prev, eventKey]));
                            }}
                          >
                            +
                          </button>
                        </div>
                        {eventExpanded && (
                          <>
                            {eventResources.map(r => renderResourceRow(r, 'resRowDeepIndented'))}
                            {renderAddAffordance({ type: 'event', id: event.id }, 'resAddAffordanceDeepIndented')}
                            {renderLinkForm({ type: 'event', id: event.id }, 'resLinkFormDeepIndented')}
                          </>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}

        {/* Unplanned events with resources */}
        {eventsWithFloatingResources.map(event => {
          const eventResources = byEvent.get(event.id) ?? [];
          const eventKey = `event-${event.id}`;
          const eventExpanded = expandedSections.has(eventKey);
          const isAddingHere = isScopeMatch({ type: 'event', id: event.id });
          const hasContent = eventResources.length > 0 || isAddingHere || (linkForm && linkForm.scope.type === 'event' && linkForm.scope.id === event.id);
          if (!hasContent) return null;
          return (
            <div key={event.id}>
              <div className="resSectionHeader" onClick={() => toggleSection(eventKey)}>
                <span className="resSectionChevron">{eventExpanded ? '▾' : '▸'}</span>
                <span className="resSectionDot" style={{ backgroundColor: event.color ?? '#C8C5BE' }} />
                <span className="resSectionName">{event.name}</span>
                <button
                  className="resSectionAddBtn"
                  onClick={e => {
                    e.stopPropagation();
                    setAddingScope(s => isScopeMatch({ type: 'event', id: event.id }) ? null : { type: 'event', id: event.id });
                    setExpandedSections(prev => new Set([...prev, eventKey]));
                  }}
                >
                  +
                </button>
              </div>
              {eventExpanded && (
                <>
                  {eventResources.map(r => renderResourceRow(r, 'resRowIndented'))}
                  {renderAddAffordance({ type: 'event', id: event.id }, 'resAddAffordanceIndented')}
                  {renderLinkForm({ type: 'event', id: event.id }, 'resLinkFormIndented')}
                </>
              )}
            </div>
          );
        })}

        {/* Floating / standalone resources */}
        {(floating.length > 0 || isScopeMatch({ type: 'floating' }) || (linkForm && linkForm.scope.type === 'floating')) && (
          <div>
            {(resources.length > floating.length || plans.length > 0) && (
              <div className="resSectionHeader" onClick={() => toggleSection('__floating__')}>
                <span className="resSectionChevron">{expandedSections.has('__floating__') ? '▾' : '▸'}</span>
                <span className="resSectionName" style={{ color: '#9B9B96' }}>Unattached</span>
              </div>
            )}
            {(expandedSections.has('__floating__') || resources.length === floating.length) && (
              <>
                {floating.map(r => renderResourceRow(r))}
                {renderAddAffordance({ type: 'floating' })}
                {renderLinkForm({ type: 'floating' })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
