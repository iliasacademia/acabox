import React, { useState, useEffect, useRef, useMemo } from 'react';
import './EventEditPopover.css';
import { PLAN_COLORS, nextAutoColor } from './calendarColors';
import type { CalendarEvent, CalendarGroup, UpdateEventData, EventDependency } from '../../../shared/types';

interface Props {
  event: CalendarEvent;
  groups: CalendarGroup[];
  allEvents: CalendarEvent[];
  dependencies: EventDependency[];
  anchorX: number;
  anchorY: number;
  onSave: (id: string, updates: UpdateEventData) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  onStatusChange?: (status: 'active' | 'inactive') => void;
  onColorChange?: (color: string) => void;
  onDependencyDelete?: (id: string) => void;
}

const POPOVER_W = 272;
const POPOVER_H = 560;

const RRULE_DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_MONTH_NAMES_EEP = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FULL_MONTHS_EEP = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK_DAYS_EEP = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];


function CalendarPickerWidget({ dateValue, onChange, onClose }: {
  dateValue: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const [vy, vm, vd] = dateValue.split('-').map(Number);
  const [viewYear, setViewYear] = useState(vy);
  const [viewMonth, setViewMonth] = useState(vm - 1);
  // focusedDate tracks keyboard cursor, separate from selected date
  const [focusedDate, setFocusedDate] = useState({ y: vy, m: vm - 1, d: vd });
  const gridRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  const firstDow = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  function moveFocusToDate(d: Date) {
    const fd = { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
    setFocusedDate(fd);
    setViewYear(fd.y);
    setViewMonth(fd.m);
    // Focus the button after React re-renders
    setTimeout(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-caldate="${fd.y}-${fd.m}-${fd.d}"]`)?.focus();
    }, 0);
  }

  function handleGridKey(e: React.KeyboardEvent) {
    const { y, m, d } = focusedDate;
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); moveFocusToDate(new Date(y, m, d - 1)); break;
      case 'ArrowRight': e.preventDefault(); moveFocusToDate(new Date(y, m, d + 1)); break;
      case 'ArrowUp':    e.preventDefault(); moveFocusToDate(new Date(y, m, d - 7)); break;
      case 'ArrowDown':  e.preventDefault(); moveFocusToDate(new Date(y, m, d + 7)); break;
      case 'PageUp':     e.preventDefault(); { const t = new Date(y, m - 1, 1); moveFocusToDate(new Date(t.getFullYear(), t.getMonth(), Math.min(d, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()))); break; }
      case 'PageDown':   e.preventDefault(); { const t = new Date(y, m + 1, 1); moveFocusToDate(new Date(t.getFullYear(), t.getMonth(), Math.min(d, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()))); break; }
      case 'Home':       e.preventDefault(); moveFocusToDate(new Date(y, m, 1)); break;
      case 'End':        e.preventDefault(); moveFocusToDate(new Date(y, m + 1, 0)); break;
      case 'Enter':
      case ' ':          e.preventDefault(); onChange(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`); onClose(); break;
    }
  }

  function prevMonth() {
    const ny = viewMonth === 0 ? viewYear - 1 : viewYear;
    const nm = viewMonth === 0 ? 11 : viewMonth - 1;
    setViewYear(ny); setViewMonth(nm);
  }
  function nextMonth() {
    const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
    const nm = viewMonth === 11 ? 0 : viewMonth + 1;
    setViewYear(ny); setViewMonth(nm);
  }

  return (
    <div className="eepCalWidget">
      <div className="eepCalNav">
        <button className="eepCalNavBtn" onClick={prevMonth} aria-label="Previous month">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5L4.5 6l3 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="eepCalMonthLabel" aria-live="polite">{FULL_MONTHS_EEP[viewMonth]} {viewYear}</span>
        <button className="eepCalNavBtn" onClick={nextMonth} aria-label="Next month">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L7.5 6l-3 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="eepCalGrid" ref={gridRef} onKeyDown={handleGridKey} role="grid">
        {WEEK_DAYS_EEP.map(wd => <span key={wd} className="eepCalWeekDay" role="columnheader" aria-label={wd}>{wd}</span>)}
        {cells.map((day, i) => {
          if (!day) return <span key={`x${i}`} role="gridcell" />;
          const isSel = day === vd && viewMonth === vm - 1 && viewYear === vy;
          const isFocused = day === focusedDate.d && viewMonth === focusedDate.m && viewYear === focusedDate.y;
          const isToday = day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
          return (
            <button
              key={i}
              role="gridcell"
              data-caldate={`${viewYear}-${viewMonth}-${day}`}
              className={`eepCalDay${isSel ? ' eepCalDaySel' : ''}${isToday && !isSel ? ' eepCalDayToday' : ''}`}
              tabIndex={isFocused ? 0 : -1}
              aria-selected={isSel}
              aria-label={`${day} ${FULL_MONTHS_EEP[viewMonth]} ${viewYear}`}
              onClick={() => { onChange(`${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`); onClose(); }}
              onFocus={() => setFocusedDate({ y: viewYear, m: viewMonth, d: day })}
            >{day}</button>
          );
        })}
      </div>
    </div>
  );
}

function parseTypedTime(s: string): string | null {
  s = s.trim().toLowerCase().replace(/\s+/g, '');
  const pm = s.includes('pm');
  const am = s.includes('am');
  s = s.replace(/[apm]/g, '');

  let h: number, m: number;
  if (s.includes(':')) {
    const [hs, ms] = s.split(':');
    h = parseInt(hs, 10);
    m = parseInt(ms || '0', 10);
  } else if (s.length <= 2) {
    h = parseInt(s, 10); m = 0;
  } else if (s.length === 3) {
    h = parseInt(s[0], 10); m = parseInt(s.slice(1), 10);
  } else if (s.length === 4) {
    h = parseInt(s.slice(0, 2), 10); m = parseInt(s.slice(2), 10);
  } else {
    return null;
  }

  if (isNaN(h) || isNaN(m) || m > 59) return null;
  if (pm && h !== 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function InlineTimeInput({ timeValue, onChange, onClose }: {
  timeValue: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => {
    const [h, m] = timeValue.split(':').map(Number);
    const isPM = h >= 12;
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
  });
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  function commit() {
    const parsed = parseTypedTime(text);
    if (parsed) {
      onChange(parsed);
      onClose();
    } else {
      setInvalid(true);
      setTimeout(() => setInvalid(false), 400);
      inputRef.current?.select();
    }
  }

  return (
    <input
      ref={inputRef}
      className={`eepTimeBtnInput${invalid ? ' eepTimeBtnInputInvalid' : ''}`}
      value={text}
      onChange={e => { setText(e.target.value); setInvalid(false); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      }}
      onBlur={commit}
      spellCheck={false}
    />
  );
}

function isoToDateValue(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoToTimeValue(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateTimeToIso(dateVal: string, timeVal: string): string {
  const [y, m, d] = dateVal.split('-').map(Number);
  const [h, min] = timeVal.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function formatDisplayDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isAllDay(startIso: string, endIso: string): boolean {
  const s = new Date(startIso);
  const e = new Date(endIso);
  return s.getHours() === 0 && s.getMinutes() === 0 && e.getHours() === 0 && e.getMinutes() === 0;
}


export function EventEditPopover({ event, groups, allEvents, dependencies, anchorX, anchorY, onSave, onDelete, onClose, onStatusChange, onColorChange, onDependencyDelete }: Props) {
  const [name, setName] = useState(event.name);
  const [groupId, setGroupId] = useState<string | null>(event.group_id);
  const [status, setStatus] = useState<'active' | 'inactive'>(
    event.status === 'inactive_hidden' ? 'inactive' : event.status
  );
  const [color, setColor] = useState(event.color ?? nextAutoColor(groups.map(g => g.color)));
  const [startIso, setStartIso] = useState(event.start_at);
  const [endIso, setEndIso] = useState(event.end_at);
  const [localGroups, setLocalGroups] = useState<CalendarGroup[]>(groups);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedFamily, setSelectedFamily] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [openPicker, setOpenPicker] = useState<'start-date' | 'start-time' | 'end-date' | 'end-time' | null>(null);
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(event.recurrence_rule ?? null);
  const [showRepeatDropdown, setShowRepeatDropdown] = useState(false);

  const repeatOptions = useMemo(() => {
    const s = new Date(startIso);
    const dow = s.getDay();
    const monthDay = s.getDate();
    const monthAbbr = SHORT_MONTH_NAMES_EEP[s.getMonth()];
    return [
      { label: 'Does not repeat', value: null },
      { label: 'Daily', value: 'RRULE:FREQ=DAILY' },
      { label: `Weekly on ${FULL_DAY_NAMES[dow]}`, value: `RRULE:FREQ=WEEKLY;BYDAY=${RRULE_DOW[dow]}` },
      { label: `Monthly on day ${monthDay}`, value: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${monthDay}` },
      { label: `Yearly on ${monthAbbr} ${monthDay}`, value: 'RRULE:FREQ=YEARLY' },
    ] as { label: string; value: string | null }[];
  }, [startIso]);

  const currentRepeatLabel = useMemo(() => {
    if (!recurrenceRule) return 'Does not repeat';
    const opt = repeatOptions.find(o => o.value === recurrenceRule);
    return opt ? opt.label : recurrenceRule.replace('RRULE:', '');
  }, [recurrenceRule, repeatOptions]);

  const nameRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const newGroupInputRef = useRef<HTMLInputElement>(null);

  const allDay = isAllDay(event.start_at, event.end_at);

  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);
  useEffect(() => { if (showNewGroup) newGroupInputRef.current?.focus(); }, [showNewGroup]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openPicker) { setOpenPicker(null); return; }
      if (showNewGroup) { setShowNewGroup(false); return; }
      if (showGroupPicker) { setShowGroupPicker(false); return; }
      if (showColorPicker) { setShowColorPicker(false); return; }
      if (showRepeatDropdown) { setShowRepeatDropdown(false); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, openPicker, showNewGroup, showGroupPicker, showColorPicker, showRepeatDropdown]);

  function handleStatusChange(newStatus: 'active' | 'inactive') {
    setStatus(newStatus);
    onStatusChange?.(newStatus);
  }

  function selectGroup(id: string | null, groupColor?: string) {
    setGroupId(id);
    let newColor: string | undefined;
    if (groupColor) {
      newColor = groupColor;
    } else if (id) {
      const g = localGroups.find(gr => gr.id === id);
      if (g) newColor = g.color;
    }
    if (newColor) {
      setColor(newColor);
      onColorChange?.(newColor);
    }
    setShowGroupPicker(false);
    setShowNewGroup(false);
    setNewGroupName('');
  }

  async function handleCreateGroup() {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    const newColor = PLAN_COLORS[selectedFamily].shades[600];
    const group = await window.calendarAPI.createGroup({ name: trimmed, color: newColor });
    setLocalGroups(prev => [...prev, group]);
    selectGroup(group.id, group.color);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(event.id, { name, group_id: groupId, status, color, start_at: startIso, end_at: endIso, recurrence_rule: recurrenceRule });
    } finally {
      setSaving(false);
      onClose();
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete(event.id);
    } finally {
      setDeleting(false);
      onClose();
    }
  }

  const selectedGroup = groupId ? localGroups.find(g => g.id === groupId) : null;

  const left = Math.min(anchorX + 8, window.innerWidth - POPOVER_W - 8);
  const top = Math.min(anchorY, window.innerHeight - POPOVER_H - 8);

  return (
    <div ref={containerRef} className="eepOverlay" style={{ left, top }}>
      {/* Name */}
      <input
        ref={nameRef}
        className="eepNameInput"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
        placeholder="Event name"
      />

      {/* Time editing */}
      <div className="eepTimeSection">
        <div className="eepTimeRow">
          <svg className="eepIcon" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" stroke="#9B9B96" strokeWidth="1.2" />
            <path d="M6 3v3l2 1.5" stroke="#9B9B96" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          {allDay ? (
            <div className="eepTimeEditGroup">
              <div className="eepTimeEditRow">
                <button className={`eepDateBtn${openPicker === 'start-date' ? ' eepPickerBtnOpen' : ''}`} onClick={() => setOpenPicker(p => p === 'start-date' ? null : 'start-date')}>
                  {formatDisplayDate(startIso)}
                </button>
                <span className="eepTimeSep">all day</span>
              </div>
            </div>
          ) : (
            <div className="eepTimeEditGroup">
              <div className="eepTimeEditRow">
                <button className={`eepDateBtn${openPicker === 'start-date' ? ' eepPickerBtnOpen' : ''}`} onClick={() => setOpenPicker(p => p === 'start-date' ? null : 'start-date')}>
                  {formatDisplayDate(startIso)}
                </button>
                {openPicker === 'start-time' ? (
                  <InlineTimeInput
                    timeValue={isoToTimeValue(startIso)}
                    onChange={v => setStartIso(dateTimeToIso(isoToDateValue(startIso), v))}
                    onClose={() => setOpenPicker(null)}
                  />
                ) : (
                  <button className="eepTimeBtn" onClick={() => setOpenPicker('start-time')}>
                    {formatDisplayTime(startIso)}
                  </button>
                )}
              </div>
              <div className="eepTimeEditRow">
                <span className="eepTimeDash">–</span>
                <button className={`eepDateBtn${openPicker === 'end-date' ? ' eepPickerBtnOpen' : ''}`} onClick={() => setOpenPicker(p => p === 'end-date' ? null : 'end-date')}>
                  {formatDisplayDate(endIso)}
                </button>
                {openPicker === 'end-time' ? (
                  <InlineTimeInput
                    timeValue={isoToTimeValue(endIso)}
                    onChange={v => setEndIso(dateTimeToIso(isoToDateValue(endIso), v))}
                    onClose={() => setOpenPicker(null)}
                  />
                ) : (
                  <button className="eepTimeBtn" onClick={() => setOpenPicker('end-time')}>
                    {formatDisplayTime(endIso)}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {openPicker === 'start-date' && (
          <CalendarPickerWidget
            dateValue={isoToDateValue(startIso)}
            onChange={v => setStartIso(dateTimeToIso(v, isoToTimeValue(startIso)))}
            onClose={() => setOpenPicker(null)}
          />
        )}
        {openPicker === 'end-date' && (
          <CalendarPickerWidget
            dateValue={isoToDateValue(endIso)}
            onChange={v => setEndIso(dateTimeToIso(v, isoToTimeValue(endIso)))}
            onClose={() => setOpenPicker(null)}
          />
        )}
      </div>

      {/* Group selector */}
      <div className="eepSection">
        <div className="eepSectionLabel">Group</div>
        {!showGroupPicker ? (
          <button
            className="eepPlanBtn"
            onClick={() => { setShowGroupPicker(true); setShowNewGroup(false); }}
          >
            {selectedGroup ? (
              <>
                <span className="eepColorDot" style={{ backgroundColor: selectedGroup.color }} />
                <span className="eepPlanName">{selectedGroup.name}</span>
              </>
            ) : (
              <>
                <span className="eepColorDotEmpty" />
                <span className="eepPlanName eepPlanNameMuted">No group</span>
              </>
            )}
            <svg className="eepChevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 4l3 3 3-3" stroke="#9B9B96" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        ) : !showNewGroup ? (
          <div className="eepPlanList">
            <button className="eepPlanPill eepPlanPillNoplan" onClick={() => selectGroup(null)}>
              <span className="eepColorDotEmpty" />
              <span>No group</span>
            </button>
            {localGroups.map(g => (
              <button key={g.id} className="eepPlanPill" onClick={() => selectGroup(g.id)}>
                <span className="eepColorDot" style={{ backgroundColor: g.color }} />
                <span>{g.name}</span>
              </button>
            ))}
            <button className="eepPlanPill eepPlanPillNew" onClick={() => setShowNewGroup(true)}>
              <span className="eepPlusDot">+</span>
              <span>New group</span>
            </button>
          </div>
        ) : (
          <div className="eepNewPlanForm">
            <input
              ref={newGroupInputRef}
              className="eepSmallInput"
              placeholder="Group name"
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); }
                if (e.key === 'Escape') { e.stopPropagation(); setShowNewGroup(false); }
              }}
            />
            <div className="eepFamilyRow">
              {PLAN_COLORS.map((fam, fi) => (
                <button
                  key={fam.family}
                  className={`eepFamilySwatch${selectedFamily === fi ? ' eepFamilySwatchSel' : ''}`}
                  style={{ backgroundColor: fam.shades[600] }}
                  onClick={() => setSelectedFamily(fi)}
                />
              ))}
            </div>
            <div className="eepNewPlanActions">
              <button className="eepSmallCancelBtn" onClick={() => { setShowNewGroup(false); setNewGroupName(''); }}>Cancel</button>
              <button className="eepSmallSaveBtn" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create</button>
            </div>
          </div>
        )}
      </div>

      {/* Color (only when no group) */}
      {!selectedGroup && (
        <div className="eepSection">
          <div className="eepSectionLabel">Color</div>
          <div className="eepColorRow">
            <button
              className="eepColorPreview"
              style={{ backgroundColor: color }}
              onClick={() => setShowColorPicker(v => !v)}
            />
            {showColorPicker && (
              <div className="eepColorPickerInline">
                {PLAN_COLORS.map((fam) => (
                  <button
                    key={fam.family}
                    className="eepFamilySwatch"
                    style={{ backgroundColor: fam.shades[600] }}
                    onClick={() => { setColor(fam.shades[600]); onColorChange?.(fam.shades[600]); setShowColorPicker(false); }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Status */}
      <div className="eepSection">
        <div className="eepSectionLabel">Status</div>
        <div className="eepStatusRow">
          <button
            className={`eepStatusPill${status === 'active' ? ' eepStatusPillActive' : ''}`}
            onClick={() => handleStatusChange('active')}
          >Active</button>
          <button
            className={`eepStatusPill${status === 'inactive' ? ' eepStatusPillActive' : ''}`}
            onClick={() => handleStatusChange('inactive')}
          >Background</button>
        </div>
      </div>

      {/* Recurrence */}
      <div className="eepSection">
        <div className="eepSectionLabel">Repeat</div>
        {!showRepeatDropdown ? (
          <button className="eepRepeatBtn" onClick={() => setShowRepeatDropdown(true)}>
            <span className="eepRepeatLabel">{currentRepeatLabel}</span>
            <svg className="eepChevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 4l3 3 3-3" stroke="#9B9B96" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <div className="eepRepeatList">
            {repeatOptions.map(opt => (
              <button
                key={opt.value ?? 'none'}
                className={`eepRepeatPill${opt.value === recurrenceRule ? ' eepRepeatPillSel' : ''}`}
                onClick={() => { setRecurrenceRule(opt.value); setShowRepeatDropdown(false); }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Dependency chain */}
      {(() => {
        const evMap = new Map(allEvents.map(e => [e.id, e]));
        const preds = dependencies.filter(d => d.successor_id === event.id);
        const succs = dependencies.filter(d => d.predecessor_id === event.id);
        if (preds.length === 0 && succs.length === 0) return null;
        return (
          <div className="depSection">
            <div className="depSectionTitle">Linked Events</div>
            <div className="depChain">
              {preds.map(d => {
                const pred = evMap.get(d.predecessor_id);
                return (
                  <div key={d.id} className="depItem">
                    <span className="depItemArrow">→</span>
                    <span className="depItemName" title={pred?.name ?? d.predecessor_id}>{pred?.name ?? '…'}</span>
                    <button className="depItemDelete" onClick={() => onDependencyDelete?.(d.id)} title="Remove link">×</button>
                  </div>
                );
              })}
              {succs.map(d => {
                const succ = evMap.get(d.successor_id);
                return (
                  <div key={d.id} className="depItem">
                    <span className="depItemArrow">←</span>
                    <span className="depItemName" title={succ?.name ?? d.successor_id}>{succ?.name ?? '…'}</span>
                    <button className="depItemDelete" onClick={() => onDependencyDelete?.(d.id)} title="Remove link">×</button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Footer */}
      <div className="eepFooter">
        <button className="eepDeleteBtn" onClick={handleDelete} disabled={deleting}>
          {deleting ? '…' : 'Delete'}
        </button>
        <button className="eepSaveBtn" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
