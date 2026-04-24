import React, { useState, useMemo, useRef, useEffect } from 'react';
import { PLAN_COLORS } from '../calendarColors';
import type { CalendarPlan, CalendarEvent } from '../../shared/types';

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
  const earliest = starts[0];
  const latest = ends[ends.length - 1];
  const startLabel = formatDateShort(earliest);
  const endLabel = formatDateShort(latest);
  if (startLabel === endLabel) return startLabel;
  return `${startLabel} – ${endLabel}`;
}

interface PlanRowProps {
  plan: CalendarPlan;
  events: CalendarEvent[];
  isDragOver: boolean;
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onEventDragStart: (event: CalendarEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDeleteClick: () => void;
}

function PlanRow({ plan, events, isDragOver, onEventClick, onEventDragStart, onDragOver, onDragLeave, onDrop, onDeleteClick }: PlanRowProps) {
  const [expanded, setExpanded] = useState(true);
  const dateRange = useMemo(() => planDateRange(events), [events]);

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
          onClick={() => setExpanded(prev => !prev)}
        >
          <svg
            className={`overviewChevron${expanded ? ' overviewChevronOpen' : ''}`}
            width="10" height="10" viewBox="0 0 10 10" fill="none"
          >
            <path d="M3.5 2.5L6 5L3.5 7.5" stroke="#9B9B95" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="overviewGroupAccent" style={{ backgroundColor: plan.color }} />
          <div className="overviewGroupMeta">
            <span className="overviewGroupName">{plan.name}</span>
            {dateRange && <span className="overviewGroupRange">{dateRange}</span>}
          </div>
        </button>
        <button
          className="overviewGroupDeleteBtn"
          onClick={(e) => { e.stopPropagation(); onDeleteClick(); }}
          title="Remove group"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {expanded && events.length > 0 && (
        <div className="overviewGroupEvents">
          {events.map(event => (
            <button
              key={event.id}
              className="overviewEventRow"
              draggable
              onDragStart={() => onEventDragStart(event)}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onEventClick?.(event, r.right, r.top + r.height / 2);
              }}
            >
              <span
                className={`overviewEventDot${event.status !== 'active' ? ' overviewEventDotInactive' : ''}`}
                style={event.status === 'active'
                  ? { backgroundColor: plan.color }
                  : { borderColor: plan.color }}
              />
              <span className="overviewEventName">{event.name}</span>
              <span className="overviewEventDate">{formatDateShort(event.start_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

interface CalendarSidebarProps {
  plans: CalendarPlan[];
  allEvents: CalendarEvent[];
  onEventClick?: (event: CalendarEvent, anchorX: number, anchorY: number) => void;
  onReassign: (eventId: string, newPlanId: string | null) => void;
  onDeletePlan: (planId: string, deleteEvents: boolean) => void;
  onCreateGroup: (name: string, color: string) => Promise<void>;
}

export function CalendarSidebar({ plans, allEvents, onEventClick, onReassign, onDeletePlan, onCreateGroup }: CalendarSidebarProps) {
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);
  const [dragOverPlanId, setDragOverPlanId] = useState<string | 'unorganized' | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<CalendarPlan | null>(null);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);

  const eventsByPlan = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of allEvents) {
      if (event.plan_id) {
        const arr = map.get(event.plan_id) ?? [];
        arr.push(event);
        map.set(event.plan_id, arr);
      }
    }
    return map;
  }, [allEvents]);

  const unplannedEvents = useMemo(
    () => allEvents.filter(e => !e.plan_id && e.status !== 'inactive_hidden'),
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

  return (
    <>
      <div className="overviewPanel" onDragEnd={handleDragEnd}>
        <div className="overviewHeader">
          <span className="overviewTitle">Overview</span>
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
        <div className="overviewList">
          {plans.map(plan => (
            <PlanRow
              key={plan.id}
              plan={plan}
              events={eventsByPlan.get(plan.id) ?? []}
              isDragOver={dragOverPlanId === plan.id}
              onEventClick={onEventClick}
              onEventDragStart={setDraggingEvent}
              onDragOver={e => handleDragOver(e, plan.id)}
              onDragLeave={() => setDragOverPlanId(null)}
              onDrop={() => handleDrop(plan.id)}
              onDeleteClick={() => setDeletingPlan(plan)}
            />
          ))}
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
            <div className="overviewSectionLabel">Unorganized Events</div>
            {unplannedEvents.map(event => (
              <button
                key={event.id}
                className="overviewEventRow overviewEventRowIndented"
                draggable
                onDragStart={() => setDraggingEvent(event)}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onEventClick?.(event, r.right, r.top + r.height / 2);
                }}
              >
                <span
                  className={`overviewEventDot overviewEventDotNeutral${event.status !== 'active' ? ' overviewEventDotInactive' : ''}`}
                />
                <span className="overviewEventName">{event.name}</span>
                <span className="overviewEventDate">{formatDateShort(event.start_at)}</span>
              </button>
            ))}
          </div>
        </div>
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
