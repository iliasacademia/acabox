import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import './CalendarPage.css';
import { CalendarChat } from './CalendarChat';
import { CalendarSidebar } from './CalendarSidebar';
import { EventEditPopover } from './EventEditPopover';
import { GcalEventPopover } from './GcalEventPopover';
import { nextAutoColor, AUTO_COLORS } from '../calendarColors';
import type { CalendarPlan, CalendarEvent, UpdateEventData } from '../../shared/types';

const GCAL_COLORS: Record<string, string> = {
  '1': '#a4bdfc', '2': '#7ae7bf', '3': '#dbadff', '4': '#ff887c',
  '5': '#fbd75b', '6': '#ffb878', '7': '#46d6db', '8': '#e1e1e1',
  '9': '#5484ed', '10': '#51b749', '11': '#dc2127',
};
const DEFAULT_GCAL_COLOR = '#4285f4';

const MIN_PANEL_WIDTH = 15;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 48;

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatWeekRange(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  const sm = SHORT_MONTHS[weekStart.getMonth()];
  const em = SHORT_MONTHS[weekEnd.getMonth()];
  const year = weekEnd.getFullYear();
  if (weekStart.getMonth() === weekEnd.getMonth()) {
    return `${sm} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${year}`;
  }
  return `${sm} ${weekStart.getDate()} – ${em} ${weekEnd.getDate()}, ${year}`;
}

function formatMonthYear(date: Date): string {
  return `${FULL_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function gcalEventColor(ev: GoogleCalendarEvent): string {
  return ev.colorId ? (GCAL_COLORS[ev.colorId] ?? DEFAULT_GCAL_COLOR) : DEFAULT_GCAL_COLOR;
}

function eventTimeOffsetAndHeight(start: Date, end: Date): { top: number; height: number } {
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const pxPerMin = HOUR_HEIGHT / 60;
  return {
    top: startMin * pxPerMin,
    height: Math.max((endMin - startMin) * pxPerMin - 2, 16),
  };
}

// For events spanning multiple days — computes top/height within a given day column using absolute timestamps
function segmentTimeOffsetAndHeight(segStart: Date, segEnd: Date, dayStart: Date): { top: number; height: number } {
  const pxPerMs = HOUR_HEIGHT / (3600 * 1000);
  const topMs = Math.max(segStart.getTime() - dayStart.getTime(), 0);
  const heightMs = Math.max(segEnd.getTime() - segStart.getTime(), 0);
  return {
    top: topMs * pxPerMs,
    height: Math.max(heightMs * pxPerMs - 2, 16),
  };
}

interface EditingEvent {
  event: CalendarEvent;
  anchorX: number;
  anchorY: number;
}

interface SelectionCommitFn {
  (startAt: Date, endAt: Date, anchorX: number, anchorY: number): void;
}

interface EventClickFn {
  (event: CalendarEvent, anchorX: number, anchorY: number): void;
}

interface EventDropFn {
  (event: CalendarEvent, newStartAt: Date, newEndAt: Date): void;
}

const GUTTER_W = 52;

interface WeekMoveDrag {
  event: CalendarEvent;
  durationMs: number;
  offsetMinutes: number;
  sourceDayIdx: number;
  targetDayIdx: number;
  targetStartMinute: number;
}

interface WeekResizeDrag {
  event: CalendarEvent;
  edge: 'top' | 'bottom';
  previewStartAt: Date;
  previewEndAt: Date;
}

interface MonthResizeDrag {
  event: CalendarEvent;
  previewEndAt: Date;
}

const MONTH_BAR_H = 16;
const MONTH_BAR_TOP = 30;
const MONTH_BAR_STRIDE = 18;

interface MonthBar {
  event: CalendarEvent;
  rowIdx: number;
  colStart: number;
  colEnd: number;
  lane: number;
  isStart: boolean;
  isEnd: boolean;
  isGhost: boolean;
}

function isMultiDayEvent(ev: CalendarEvent): boolean {
  const evStart = new Date(ev.start_at);
  const evEnd = new Date(ev.end_at);
  const startDay = new Date(evStart.getFullYear(), evStart.getMonth(), evStart.getDate());
  const endsAtMidnight = evEnd.getHours() === 0 && evEnd.getMinutes() === 0 && evEnd.getSeconds() === 0;
  const endDayRaw = endsAtMidnight ? new Date(evEnd.getTime() - 86400000) : evEnd;
  const endDay = new Date(endDayRaw.getFullYear(), endDayRaw.getMonth(), endDayRaw.getDate());
  return endDay > startDay;
}

function WeekView({ weekStart, today, googleEvents, localEvents, onSelectionCommit, onEventClick, onGcalEventClick, onEventDrop, blocked }: {
  weekStart: Date;
  today: Date;
  googleEvents: GoogleCalendarEvent[];
  localEvents: CalendarEvent[];
  onSelectionCommit: SelectionCommitFn;
  onEventClick: EventClickFn;
  onGcalEventClick: (ev: GoogleCalendarEvent, x: number, y: number) => void;
  onEventDrop: EventDropFn;
  blocked: React.MutableRefObject<boolean>;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dragStart, setDragStart] = useState<{ dayIdx: number; hour: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ dayIdx: number; hour: number } | null>(null);
  const isDragging = useRef(false);
  const dragEndRef = useRef<{ dayIdx: number; hour: number } | null>(null);
  dragEndRef.current = dragEnd;

  const [moveDrag, setMoveDrag] = useState<WeekMoveDrag | null>(null);
  const moveDragRef = useRef<WeekMoveDrag | null>(null);
  moveDragRef.current = moveDrag;

  const [resizeDrag, setResizeDrag] = useState<WeekResizeDrag | null>(null);
  const resizeDragRef = useRef<WeekResizeDrag | null>(null);
  resizeDragRef.current = resizeDrag;

  useEffect(() => {
    if (!bodyRef.current) return;
    const isCurrentWeek = days.some(d => isSameDay(d, today));
    const scrollHour = isCurrentWeek ? Math.max(0, today.getHours() - 1) : 7;
    bodyRef.current.scrollTop = scrollHour * HOUR_HEIGHT;
  }, [weekStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { isDragging.current = false; }, []);

  useEffect(() => {
    const body = bodyRef.current;
    const header = headerRef.current;
    if (!body || !header) return;
    const sync = () => { header.style.paddingRight = `${body.offsetWidth - body.clientWidth}px`; };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const eventsByDay = useMemo(() => {
    const map: GoogleCalendarEvent[][] = days.map(() => []);
    for (const ev of googleEvents) {
      if (!ev.start.dateTime) continue;
      const evStart = new Date(ev.start.dateTime);
      const dayIdx = days.findIndex(d => isSameDay(d, evStart));
      if (dayIdx !== -1) map[dayIdx].push(ev);
    }
    return map;
  }, [googleEvents, weekStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Include multi-day events in all columns they overlap; apply resize preview
  const localByDay = useMemo(() => {
    const map: CalendarEvent[][] = days.map(() => []);
    const effectiveEvents = localEvents.map(ev =>
      resizeDrag?.event.id === ev.id
        ? { ...ev, start_at: resizeDrag.previewStartAt.toISOString(), end_at: resizeDrag.previewEndAt.toISOString() }
        : ev
    );
    for (const ev of effectiveEvents) {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      for (let di = 0; di < 7; di++) {
        const dayStart = days[di];
        const dayEnd = addDays(dayStart, 1);
        if (evStart < dayEnd && evEnd > dayStart) {
          map[di].push(ev);
        }
      }
    }
    return map;
  }, [localEvents, weekStart.getTime(), resizeDrag]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCellMouseDown(dayIdx: number, hour: number, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.preventDefault();
    isDragging.current = true;
    setDragStart({ dayIdx, hour });
    setDragEnd({ dayIdx, hour });

    const onMouseUp = (upEvent: MouseEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const de = dragEndRef.current ?? { dayIdx, hour };
      const minDayIdx = Math.min(dayIdx, de.dayIdx);
      const maxDayIdx = Math.max(dayIdx, de.dayIdx);
      const isLeftward = de.dayIdx < dayIdx;
      const startHour = isLeftward ? de.hour : hour;
      const endHour = isLeftward ? hour : de.hour;
      const startDay = days[minDayIdx];
      const startAt = new Date(startDay);
      let endAt: Date;
      if (minDayIdx === maxDayIdx) {
        const minH = Math.min(startHour, endHour);
        const maxH = Math.max(startHour, endHour);
        startAt.setHours(minH, 0, 0, 0);
        endAt = new Date(startDay);
        endAt.setHours(maxH + 1, 0, 0, 0);
      } else {
        startAt.setHours(startHour, 0, 0, 0);
        const endDay = days[maxDayIdx];
        endAt = new Date(endDay);
        endAt.setHours(endHour + 1, 0, 0, 0);
      }
      setDragStart(null);
      setDragEnd(null);
      document.removeEventListener('mouseup', onMouseUp);
      onSelectionCommit(startAt, endAt, upEvent.clientX, upEvent.clientY);
    };
    document.addEventListener('mouseup', onMouseUp);
  }

  function handleEventDragStart(ev: CalendarEvent, dayIdx: number, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.stopPropagation();
    e.preventDefault();
    if (!bodyRef.current) return;

    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    const durationMs = evEnd.getTime() - evStart.getTime();
    const evStartMinute = evStart.getHours() * 60 + evStart.getMinutes();
    const bodyRect = bodyRef.current.getBoundingClientRect();
    const relY = e.clientY - bodyRect.top + bodyRef.current.scrollTop;
    const clickMinute = (relY / HOUR_HEIGHT) * 60;
    const offsetMinutes = Math.max(0, clickMinute - evStartMinute);

    const drag: WeekMoveDrag = {
      event: ev, durationMs, offsetMinutes,
      sourceDayIdx: dayIdx, targetDayIdx: dayIdx,
      targetStartMinute: evStartMinute,
    };
    setMoveDrag(drag);
    moveDragRef.current = drag;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      if (!bodyRef.current || !moveDragRef.current) return;
      const br = bodyRef.current.getBoundingClientRect();
      const colW = (br.width - GUTTER_W) / 7;
      const relX = me.clientX - br.left - GUTTER_W;
      const relY2 = me.clientY - br.top + bodyRef.current.scrollTop;
      const targetDayIdx = Math.max(0, Math.min(6, Math.floor(relX / colW)));
      const durationMinutes = moveDragRef.current.durationMs / 1000 / 60;
      const rawStart = (relY2 / HOUR_HEIGHT) * 60 - moveDragRef.current.offsetMinutes;
      const snapped = Math.round(rawStart / 15) * 15;
      const targetStartMinute = Math.max(0, Math.min(24 * 60 - durationMinutes, snapped));
      const updated = { ...moveDragRef.current, targetDayIdx, targetStartMinute };
      moveDragRef.current = updated;
      setMoveDrag(updated);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const d = moveDragRef.current;
      moveDragRef.current = null;
      setMoveDrag(null);
      if (!d) return;
      const targetDay = days[d.targetDayIdx];
      const newStart = new Date(targetDay);
      newStart.setHours(Math.floor(d.targetStartMinute / 60), d.targetStartMinute % 60, 0, 0);
      const newEnd = new Date(newStart.getTime() + d.durationMs);
      if (newStart.toISOString() !== d.event.start_at || d.targetDayIdx !== d.sourceDayIdx) {
        onEventDrop(d.event, newStart, newEnd);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleResizeStart(ev: CalendarEvent, edge: 'top' | 'bottom', e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.stopPropagation();
    e.preventDefault();
    if (!bodyRef.current) return;

    const drag: WeekResizeDrag = {
      event: ev, edge,
      previewStartAt: new Date(ev.start_at),
      previewEndAt: new Date(ev.end_at),
    };
    setResizeDrag(drag);
    resizeDragRef.current = drag;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      if (!bodyRef.current || !resizeDragRef.current) return;
      const br = bodyRef.current.getBoundingClientRect();
      const colW = (br.width - GUTTER_W) / 7;
      const relX = me.clientX - br.left - GUTTER_W;
      const cursorDayIdx = Math.max(0, Math.min(6, Math.floor(relX / colW)));
      const cursorDay = days[cursorDayIdx];
      const relY = me.clientY - br.top + bodyRef.current.scrollTop;
      const rawMinute = (relY / HOUR_HEIGHT) * 60;
      const snapped = Math.round(rawMinute / 15) * 15;
      const clampedMinute = Math.max(0, Math.min(24 * 60, snapped));
      const d = resizeDragRef.current;

      if (d.edge === 'bottom') {
        const newEnd = new Date(cursorDay);
        newEnd.setHours(Math.floor(clampedMinute / 60), clampedMinute % 60, 0, 0);
        const minEnd = new Date(d.previewStartAt.getTime() + 15 * 60 * 1000);
        const updated = { ...d, previewEndAt: newEnd > minEnd ? newEnd : minEnd };
        resizeDragRef.current = updated;
        setResizeDrag(updated);
      } else {
        const newStart = new Date(cursorDay);
        newStart.setHours(Math.floor(clampedMinute / 60), clampedMinute % 60, 0, 0);
        const maxStart = new Date(d.previewEndAt.getTime() - 15 * 60 * 1000);
        const updated = { ...d, previewStartAt: newStart < maxStart ? newStart : maxStart };
        resizeDragRef.current = updated;
        setResizeDrag(updated);
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const d = resizeDragRef.current;
      resizeDragRef.current = null;
      setResizeDrag(null);
      if (!d) return;
      if (d.previewStartAt.toISOString() !== d.event.start_at || d.previewEndAt.toISOString() !== d.event.end_at) {
        onEventDrop(d.event, d.previewStartAt, d.previewEndAt);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function getDraftOverlay(dayIdx: number): { top: number; height: number } | null {
    if (!dragStart || !dragEnd) return null;
    const minDayIdx = Math.min(dragStart.dayIdx, dragEnd.dayIdx);
    const maxDayIdx = Math.max(dragStart.dayIdx, dragEnd.dayIdx);
    if (dayIdx < minDayIdx || dayIdx > maxDayIdx) return null;
    const isLeftward = dragEnd.dayIdx < dragStart.dayIdx;
    const startHour = isLeftward ? dragEnd.hour : dragStart.hour;
    const endHour = isLeftward ? dragStart.hour : dragEnd.hour;
    if (minDayIdx === maxDayIdx) {
      const minH = Math.min(startHour, endHour);
      const maxH = Math.max(startHour, endHour);
      return { top: minH * HOUR_HEIGHT, height: (maxH - minH + 1) * HOUR_HEIGHT };
    }
    if (dayIdx === minDayIdx) return { top: startHour * HOUR_HEIGHT, height: (24 - startHour) * HOUR_HEIGHT };
    if (dayIdx === maxDayIdx) return { top: 0, height: (endHour + 1) * HOUR_HEIGHT };
    return { top: 0, height: 24 * HOUR_HEIGHT };
  }

  return (
    <div className="weekView">
      <div className="weekHeader" ref={headerRef}>
        <div className="weekTimeGutter" />
        {days.map((day, i) => (
          <div key={i} className={`weekDayHeader${isSameDay(day, today) ? ' weekDayHeaderToday' : ''}`}>
            <span className="weekDayName">{SHORT_DAYS[i]}</span>
            <span className={`weekDayNumber${isSameDay(day, today) ? ' weekDayNumberToday' : ''}`}>
              {day.getDate()}
            </span>
          </div>
        ))}
      </div>
      <div className="weekBody" ref={bodyRef}>
        <div className="weekTimeColumn">
          {HOURS.map(hour => (
            <div key={hour} className="weekTimeSlot" style={{ height: HOUR_HEIGHT }}>
              {hour > 0 && (
                <span className="weekTimeLabel">
                  {hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`}
                </span>
              )}
            </div>
          ))}
        </div>
        {days.map((day, i) => {
          const overlay = getDraftOverlay(i);
          const dayStart = day;
          const dayEnd = addDays(day, 1);
          const LANE_W = 22;
          const LANE_GAP = 4;
          const activeEvents = localByDay[i].filter(ev => ev.status === 'active');
          const bgLanes = [...localByDay[i].filter(ev => ev.status !== 'active')]
            .sort((a, b) => a.start_at.localeCompare(b.start_at));

          return (
            <div
              key={i}
              className={`weekDayColumn${isSameDay(day, today) ? ' weekDayColumnToday' : ''}`}
              style={{ position: 'relative' }}
            >
              {HOURS.map(hour => (
                <div
                  key={hour}
                  className="weekHourCell"
                  style={{ height: HOUR_HEIGHT }}
                  onMouseDown={(e) => handleCellMouseDown(i, hour, e)}
                  onMouseEnter={() => {
                    if (isDragging.current) {
                      setDragEnd({ dayIdx: i, hour });
                    }
                  }}
                />
              ))}
              {overlay && (
                <div className="weekDraftOverlay" style={{ top: overlay.top, height: overlay.height }} />
              )}
              {/* Google Calendar events */}
              {eventsByDay[i].map(ev => {
                const start = new Date(ev.start.dateTime!);
                const end = new Date(ev.end.dateTime!);
                const { top, height } = eventTimeOffsetAndHeight(start, end);
                const color = gcalEventColor(ev);
                return (
                  <div
                    key={ev.id}
                    className="gcalEvent"
                    style={{ top, height, backgroundColor: color + '33', borderLeft: `3px solid ${color}`, cursor: 'pointer' }}
                    title={ev.summary ?? ''}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onGcalEventClick(ev, e.clientX, e.clientY); }}
                  >
                    <span className="gcalEventTitle">{ev.summary}</span>
                    {height >= 36 && (
                      <span className="gcalEventTime">
                        {start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                    <span className="gcalImportBadge" title="From Google Calendar">G</span>
                  </div>
                );
              })}
              {/* Active local events */}
              {activeEvents.map(ev => {
                const isMoving = moveDrag?.event.id === ev.id;
                const evStart = new Date(ev.start_at);
                const evEnd = new Date(ev.end_at);
                const segStart = evStart > dayStart ? evStart : dayStart;
                const segEnd = evEnd < dayEnd ? evEnd : dayEnd;
                const { top, height } = segmentTimeOffsetAndHeight(segStart, segEnd, dayStart);
                const isFirstDay = evStart >= dayStart && evStart < dayEnd;
                const isLastDay = evEnd > dayStart && evEnd <= dayEnd;
                const color = ev.color ?? AUTO_COLORS[0];
                return (
                  <div
                    key={ev.id}
                    className="gcalEvent localEvent"
                    style={{
                      top, height, left: 3, right: 3,
                      backgroundColor: color + 'dd',
                      borderLeft: `3px solid ${color}`,
                      cursor: 'grab',
                      opacity: isMoving ? 0.25 : 1,
                      zIndex: 2,
                    }}
                    title={ev.name}
                    onMouseDown={e => handleEventDragStart(ev, i, e)}
                    onClick={e => { e.stopPropagation(); if (!moveDrag && !resizeDrag) onEventClick(ev, e.clientX, e.clientY); }}
                  >
                    {isFirstDay && (
                      <div className="weekEventResizeHandle weekEventResizeHandleTop"
                        onMouseDown={e => handleResizeStart(ev, 'top', e)} />
                    )}
                    <span className="gcalEventTitle" style={{ color: '#fff' }}>{ev.name}</span>
                    {height >= 36 && (
                      <span className="gcalEventTime" style={{ color: 'rgba(255,255,255,0.8)' }}>
                        {evStart.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                    {isLastDay && (
                      <div className="weekEventResizeHandle weekEventResizeHandleBottom"
                        onMouseDown={e => handleResizeStart(ev, 'bottom', e)} />
                    )}
                  </div>
                );
              })}
              {/* Ghost for active move drag */}
              {moveDrag?.event.status === 'active' && moveDrag.targetDayIdx === i && (() => {
                const ev = moveDrag.event;
                const color = ev.color ?? AUTO_COLORS[0];
                const pxPerMin = HOUR_HEIGHT / 60;
                const ghostTop = moveDrag.targetStartMinute * pxPerMin;
                const ghostHeight = Math.max(moveDrag.durationMs / 1000 / 60 * pxPerMin, 18);
                return (
                  <div className="gcalEvent localEvent" style={{
                    top: ghostTop, height: ghostHeight, left: 3, right: 3,
                    backgroundColor: color + 'dd', borderLeft: `3px solid ${color}`,
                    opacity: 0.75, pointerEvents: 'none', zIndex: 3,
                  }}>
                    <span className="gcalEventTitle" style={{ color: '#fff' }}>{ev.name}</span>
                  </div>
                );
              })()}
              {/* Background lane events */}
              {bgLanes.map((ev, laneIdx) => {
                const isMoving = moveDrag?.event.id === ev.id;
                const evStart = new Date(ev.start_at);
                const evEnd = new Date(ev.end_at);
                const segStart = evStart > dayStart ? evStart : dayStart;
                const segEnd = evEnd < dayEnd ? evEnd : dayEnd;
                const { top, height } = segmentTimeOffsetAndHeight(segStart, segEnd, dayStart);
                const isFirstDay = evStart >= dayStart && evStart < dayEnd;
                const isLastDay = evEnd > dayStart && evEnd <= dayEnd;
                const color = ev.color ?? AUTO_COLORS[0];
                return (
                  <div
                    key={ev.id}
                    className="weekBgLane"
                    style={{
                      top, height,
                      left: 2 + laneIdx * (LANE_W + LANE_GAP),
                      width: LANE_W,
                      backgroundColor: color + '18',
                      borderColor: color + '70',
                      cursor: 'grab',
                      opacity: isMoving ? 0.25 : 1,
                    }}
                    title={ev.name}
                    onMouseDown={e => handleEventDragStart(ev, i, e)}
                    onClick={e => { e.stopPropagation(); if (!moveDrag && !resizeDrag) onEventClick(ev, e.clientX, e.clientY); }}
                  >
                    {isFirstDay && (
                      <div className="weekEventResizeHandle weekEventResizeHandleTop"
                        onMouseDown={e => handleResizeStart(ev, 'top', e)} />
                    )}
                    <span className="weekBgLaneLabel" style={{ color }}>{ev.name}</span>
                    {isLastDay && (
                      <div className="weekEventResizeHandle weekEventResizeHandleBottom"
                        onMouseDown={e => handleResizeStart(ev, 'bottom', e)} />
                    )}
                  </div>
                );
              })}
              {/* Ghost for background move drag */}
              {moveDrag && moveDrag.event.status !== 'active' && moveDrag.targetDayIdx === i && (() => {
                const ev = moveDrag.event;
                const color = ev.color ?? AUTO_COLORS[0];
                const pxPerMin = HOUR_HEIGHT / 60;
                const ghostTop = moveDrag.targetStartMinute * pxPerMin;
                const ghostHeight = Math.max(moveDrag.durationMs / 1000 / 60 * pxPerMin - 2, 16);
                return (
                  <div className="weekBgLane" style={{
                    top: ghostTop, height: ghostHeight,
                    left: 2 + bgLanes.length * (LANE_W + LANE_GAP),
                    width: LANE_W,
                    backgroundColor: color + '18',
                    borderColor: color + '70',
                    opacity: 0.75, pointerEvents: 'none', zIndex: 3,
                  }}>
                    <span className="weekBgLaneLabel" style={{ color }}>{ev.name}</span>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({ anchorDate, today, googleEvents, localEvents, onSelectionCommit, onEventClick, onGcalEventClick, onEventDrop, onMoreClick, blocked }: {
  anchorDate: Date;
  today: Date;
  googleEvents: GoogleCalendarEvent[];
  localEvents: CalendarEvent[];
  onSelectionCommit: SelectionCommitFn;
  onEventClick: EventClickFn;
  onGcalEventClick: (ev: GoogleCalendarEvent, x: number, y: number) => void;
  onEventDrop: EventDropFn;
  onMoreClick: (date: Date) => void;
  blocked: React.MutableRefObject<boolean>;
}) {
  const monthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const startDay = monthStart.getDay();
  const prefixDays = startDay === 0 ? 6 : startDay - 1;
  const gridStart = addDays(monthStart, -prefixDays);
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    [gridStart.getTime()] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [dragStart, setDragStart] = useState<Date | null>(null);
  const [dragEnd, setDragEnd] = useState<Date | null>(null);
  const isDragging = useRef(false);
  const dragEndRef = useRef<Date | null>(null);
  dragEndRef.current = dragEnd;

  const [moveDrag, setMoveDrag] = useState<{ event: CalendarEvent; targetDate: Date } | null>(null);
  const moveDragRef = useRef<{ event: CalendarEvent; targetDate: Date } | null>(null);
  moveDragRef.current = moveDrag;

  const [monthResizeDrag, setMonthResizeDrag] = useState<MonthResizeDrag | null>(null);
  const monthResizeDragRef = useRef<MonthResizeDrag | null>(null);
  monthResizeDragRef.current = monthResizeDrag;

  const monthGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { isDragging.current = false; }, []);

  function handleEventDragStart(ev: CalendarEvent, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.stopPropagation();
    e.preventDefault();
    const evStart = new Date(ev.start_at);
    const sourceDate = new Date(evStart.getFullYear(), evStart.getMonth(), evStart.getDate());
    const drag = { event: ev, targetDate: sourceDate };
    setMoveDrag(drag);
    moveDragRef.current = drag;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const onUp = () => {
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const d = moveDragRef.current;
      moveDragRef.current = null;
      setMoveDrag(null);
      if (!d) return;
      const evStart2 = new Date(d.event.start_at);
      const evEnd2 = new Date(d.event.end_at);
      const durationMs = evEnd2.getTime() - evStart2.getTime();
      const src = new Date(evStart2.getFullYear(), evStart2.getMonth(), evStart2.getDate());
      if (d.targetDate.getTime() !== src.getTime()) {
        const dayDiff = Math.round((d.targetDate.getTime() - src.getTime()) / 86400000);
        const newStart = new Date(evStart2.getTime() + dayDiff * 86400000);
        const newEnd = new Date(newStart.getTime() + durationMs);
        onEventDrop(d.event, newStart, newEnd);
      }
    };
    document.addEventListener('mouseup', onUp);
  }

  function handleMonthResizeStart(ev: CalendarEvent, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.stopPropagation();
    e.preventDefault();
    const drag: MonthResizeDrag = { event: ev, previewEndAt: new Date(ev.end_at) };
    setMonthResizeDrag(drag);
    monthResizeDragRef.current = drag;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      if (!monthGridRef.current || !monthResizeDragRef.current) return;
      const br = monthGridRef.current.getBoundingClientRect();
      const col = Math.max(0, Math.min(6, Math.floor((me.clientX - br.left) / (br.width / 7))));
      const row = Math.max(0, Math.min(5, Math.floor((me.clientY - br.top) / (br.height / 6))));
      const date = cells[row * 7 + col];
      const d = monthResizeDragRef.current;
      const evStartDay = new Date(new Date(d.event.start_at).setHours(0, 0, 0, 0));
      if (date >= evStartDay) {
        const newEnd = new Date(date.getTime() + 86400000);
        if (newEnd.getTime() !== d.previewEndAt.getTime()) {
          const updated = { ...d, previewEndAt: newEnd };
          monthResizeDragRef.current = updated;
          setMonthResizeDrag(updated);
        }
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const d = monthResizeDragRef.current;
      monthResizeDragRef.current = null;
      setMonthResizeDrag(null);
      if (!d) return;
      if (d.previewEndAt.toISOString() !== d.event.end_at) {
        onEventDrop(d.event, new Date(d.event.start_at), d.previewEndAt);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const eventsByDate = useMemo(() => {
    const map = new Map<string, GoogleCalendarEvent[]>();
    for (const ev of googleEvents) {
      const dt = ev.start.dateTime ?? ev.start.date;
      if (!dt) continue;
      const key = dt.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [googleEvents]);

  function dateKey(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Multi-day events appear in all days they span; apply month resize preview
  const localByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const effectiveEvents = localEvents.map(ev =>
      monthResizeDrag?.event.id === ev.id
        ? { ...ev, end_at: monthResizeDrag.previewEndAt.toISOString() }
        : ev
    );
    for (const ev of effectiveEvents) {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const startDate = new Date(evStart.getFullYear(), evStart.getMonth(), evStart.getDate());
      const endsAtMidnight = evEnd.getHours() === 0 && evEnd.getMinutes() === 0 && evEnd.getSeconds() === 0;
      const endDate = endsAtMidnight
        ? new Date(evEnd.getTime() - 86400000)
        : new Date(evEnd.getFullYear(), evEnd.getMonth(), evEnd.getDate());
      let cur = new Date(startDate);
      while (cur <= endDate) {
        const key = dateKey(cur);
        if (!map.has(key)) map.set(key, []);
        if (!map.get(key)!.some(e => e.id === ev.id)) {
          map.get(key)!.push(ev);
        }
        cur = new Date(cur.getTime() + 86400000);
      }
    }
    return map;
  }, [localEvents, monthResizeDrag]);

  const multiDayBars = useMemo((): MonthBar[] => {
    const effectiveEvents = localEvents.map(ev =>
      monthResizeDrag?.event.id === ev.id
        ? { ...ev, end_at: monthResizeDrag.previewEndAt.toISOString() }
        : ev
    ).filter(isMultiDayEvent);

    const bars: MonthBar[] = [];
    const colLanes: number[][] = Array.from({ length: 6 }, () => Array(7).fill(0));
    const gst = gridStart.getTime();

    const addBars = (ev: CalendarEvent, isGhost: boolean) => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const startDate = new Date(evStart.getFullYear(), evStart.getMonth(), evStart.getDate());
      const endsAtMidnight = evEnd.getHours() === 0 && evEnd.getMinutes() === 0 && evEnd.getSeconds() === 0;
      const endDateRaw = endsAtMidnight ? new Date(evEnd.getTime() - 86400000) : evEnd;
      const endDate = new Date(endDateRaw.getFullYear(), endDateRaw.getMonth(), endDateRaw.getDate());
      const firstIdx = Math.round((startDate.getTime() - gst) / 86400000);
      const lastIdx = Math.round((endDate.getTime() - gst) / 86400000);
      if (firstIdx > 41 || lastIdx < 0) return;
      const cf = Math.max(0, firstIdx);
      const cl = Math.min(41, lastIdx);
      for (let idx = cf; idx <= cl; ) {
        const row = Math.floor(idx / 7);
        if (row >= 6) break;
        const colStart = idx % 7;
        const colEnd = Math.min(6, cl - row * 7);
        let lane = 0;
        for (let c = colStart; c <= colEnd; c++) lane = Math.max(lane, colLanes[row][c]);
        if (!isGhost) for (let c = colStart; c <= colEnd; c++) colLanes[row][c] = lane + 1;
        bars.push({ event: ev, rowIdx: row, colStart, colEnd, lane, isStart: idx === cf, isEnd: row * 7 + colEnd === cl, isGhost });
        idx = (row + 1) * 7;
      }
    };

    for (const ev of effectiveEvents) addBars(ev, false);

    // Ghost bars for multi-day move drag
    if (moveDrag && isMultiDayEvent(moveDrag.event)) {
      const orig = moveDrag.event;
      const evStart = new Date(orig.start_at);
      const evEnd = new Date(orig.end_at);
      const origDay = new Date(evStart.getFullYear(), evStart.getMonth(), evStart.getDate());
      const dayDiff = Math.round((moveDrag.targetDate.getTime() - origDay.getTime()) / 86400000);
      if (dayDiff !== 0) {
        const ghostEv = {
          ...orig,
          start_at: new Date(evStart.getTime() + dayDiff * 86400000).toISOString(),
          end_at: new Date(evEnd.getTime() + dayDiff * 86400000).toISOString(),
        };
        addBars(ghostEv, true);
      }
    }

    return bars;
  }, [localEvents, monthResizeDrag, moveDrag, gridStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowMaxLanes = useMemo(() => {
    const maxes = Array(6).fill(0);
    for (const bar of multiDayBars) {
      if (!bar.isGhost) maxes[bar.rowIdx] = Math.max(maxes[bar.rowIdx], bar.lane + 1);
    }
    return maxes;
  }, [multiDayBars]);

  function inDraftRange(d: Date): boolean {
    if (!dragStart || !dragEnd) return false;
    const a = dragStart < dragEnd ? dragStart : dragEnd;
    const b = dragStart < dragEnd ? dragEnd : dragStart;
    return d >= a && d <= b;
  }

  function handleCellMouseDown(date: Date, e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (blocked.current) return;
    e.preventDefault();
    isDragging.current = true;
    setDragStart(date);
    setDragEnd(date);

    const onMouseUp = (upEvent: MouseEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const de = dragEndRef.current ?? date;
      const minDate = date < de ? date : de;
      const maxDate = date < de ? de : date;
      const startAt = new Date(minDate);
      startAt.setHours(0, 0, 0, 0);
      const endAt = new Date(maxDate);
      endAt.setDate(endAt.getDate() + 1);
      endAt.setHours(0, 0, 0, 0);
      setDragStart(null);
      setDragEnd(null);
      document.removeEventListener('mouseup', onMouseUp);
      onSelectionCommit(startAt, endAt, upEvent.clientX, upEvent.clientY);
    };
    document.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div className="monthView">
      <div className="monthDayNames">
        {SHORT_DAYS.map(d => (
          <div key={d} className="monthDayName">{d}</div>
        ))}
      </div>
      <div className="monthGrid" ref={monthGridRef} style={{ position: 'relative' }}>
        {cells.map((date, i) => {
          const isCurrent = date.getMonth() === anchorDate.getMonth();
          const isToday = isSameDay(date, today);
          const isDraft = inDraftRange(date);
          const dayEvents = eventsByDate.get(dateKey(date)) ?? [];
          const dayLocal = localByDate.get(dateKey(date)) ?? [];
          const dayLocalSingle = dayLocal.filter(ev => !isMultiDayEvent(ev));
          const row = Math.floor(i / 7);
          const nLanes = rowMaxLanes[row];

          return (
            <div
              key={i}
              className={`monthCell${!isCurrent ? ' monthCellOtherMonth' : ''}${isDraft ? ' monthCellDraft' : ''}`}
              onMouseDown={(e) => handleCellMouseDown(date, e)}
              onMouseEnter={() => {
                if (moveDragRef.current) {
                  const updated = { ...moveDragRef.current, targetDate: date };
                  moveDragRef.current = updated;
                  setMoveDrag(updated);
                } else if (isDragging.current) {
                  setDragEnd(date);
                }
              }}
            >
              <span className={`monthCellDate${isToday ? ' monthCellDateToday' : ''}`}>
                {date.getDate()}
              </span>
              <div className="monthCellEvents" style={{ marginTop: nLanes === 0 ? 3 : nLanes * MONTH_BAR_STRIDE + 2 }}>
                {dayEvents.slice(0, 3).map(ev => (
                  <div
                    key={ev.id}
                    className="monthGcalEvent"
                    style={{ backgroundColor: gcalEventColor(ev), cursor: 'pointer' }}
                    title={ev.summary ?? ''}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onGcalEventClick(ev, e.clientX, e.clientY); }}
                  >
                    <span className="monthGcalImportDot">G</span>{ev.summary}
                  </div>
                ))}
                {dayLocalSingle.map(ev => {
                  const color = ev.color ?? AUTO_COLORS[0];
                  const isBg = ev.status !== 'active';
                  const isMoving = moveDrag?.event.id === ev.id;
                  const evEnd = new Date(ev.end_at);
                  const midnightEnd = evEnd.getHours() === 0 && evEnd.getMinutes() === 0;
                  const isLastDay = midnightEnd
                    ? isSameDay(new Date(evEnd.getTime() - 86400000), date)
                    : isSameDay(evEnd, date);
                  return (
                    <div
                      key={ev.id}
                      className={`monthGcalEvent monthLocalEvent${isBg ? ' monthBgEvent' : ''}`}
                      style={isBg
                        ? { backgroundColor: color + '18', border: `1.5px dashed ${color}88`, color, opacity: isMoving ? 0.25 : 1, cursor: 'grab', position: 'relative' }
                        : { backgroundColor: color + 'dd', opacity: isMoving ? 0.25 : 1, cursor: 'grab', position: 'relative' }
                      }
                      title={ev.name}
                      onMouseDown={e => handleEventDragStart(ev, e)}
                      onClick={e => { e.stopPropagation(); if (!moveDrag && !monthResizeDrag) onEventClick(ev, e.clientX, e.clientY); }}
                    >
                      {ev.name}
                      {isLastDay && (
                        <div className="monthEventResizeHandle" onMouseDown={e => handleMonthResizeStart(ev, e)} />
                      )}
                    </div>
                  );
                })}
                {/* Ghost pill for single-day move drag */}
                {moveDrag && !isMultiDayEvent(moveDrag.event) && isSameDay(date, moveDrag.targetDate) && (() => {
                  const ev = moveDrag.event;
                  const color = ev.color ?? AUTO_COLORS[0];
                  const isBg = ev.status !== 'active';
                  return (
                    <div
                      className={`monthGcalEvent${isBg ? ' monthBgEvent' : ''}`}
                      style={isBg
                        ? { backgroundColor: color + '18', border: `1.5px dashed ${color}88`, color, opacity: 0.75, pointerEvents: 'none' }
                        : { backgroundColor: color + 'dd', opacity: 0.75, pointerEvents: 'none' }
                      }
                    >
                      {ev.name}
                    </div>
                  );
                })()}
                {dayEvents.length > 3 && (
                  <button
                    className="monthGcalMore"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onMoreClick(date); }}
                  >+{dayEvents.length - 3} more</button>
                )}
              </div>
            </div>
          );
        })}

        {/* Multi-day event bars — absolutely positioned over the grid */}
        {multiDayBars.map((bar, bi) => {
          const ev = bar.event;
          const color = ev.color ?? AUTO_COLORS[0];
          const isBg = ev.status !== 'active';
          const isMoving = !bar.isGhost && moveDrag?.event.id === ev.id;
          return (
            <div
              key={`${ev.id}-r${bar.rowIdx}-${bi}`}
              className="monthMultiDayBar"
              style={{
                top: `calc(${bar.rowIdx} / 6 * 100% + ${MONTH_BAR_TOP + bar.lane * MONTH_BAR_STRIDE}px)`,
                left: `calc(${bar.colStart} / 7 * 100% + ${bar.isStart ? 3 : 0}px)`,
                width: `calc(${bar.colEnd - bar.colStart + 1} / 7 * 100% - ${bar.isStart ? 3 : 0}px - ${bar.isEnd ? 3 : 0}px)`,
                height: MONTH_BAR_H,
                backgroundColor: isBg ? color + '18' : color + 'dd',
                ...(isBg ? { border: `1.5px dashed ${color}88` } : {}),
                borderRadius: `${bar.isStart ? 3 : 0}px ${bar.isEnd ? 3 : 0}px ${bar.isEnd ? 3 : 0}px ${bar.isStart ? 3 : 0}px`,
                opacity: bar.isGhost ? 0.75 : isMoving ? 0.25 : 1,
                pointerEvents: bar.isGhost ? 'none' : 'auto',
              }}
              onMouseDown={e => handleEventDragStart(ev, e)}
              onClick={e => { e.stopPropagation(); if (!moveDrag && !monthResizeDrag) onEventClick(ev, e.clientX, e.clientY); }}
            >
              {bar.isStart && (
                <span className="monthMultiDayBarLabel" style={isBg ? { color } : { color: '#fff' }}>
                  {ev.name}
                </span>
              )}
              {bar.isEnd && !bar.isGhost && (
                <div className="monthEventResizeHandle" onMouseDown={e => handleMonthResizeStart(ev, e)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(20);
  const [rightWidth, setRightWidth] = useState(20);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;

  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const today = useMemo(() => new Date(), []);

  const [gcalConnected, setGcalConnected] = useState(false);
  const [gcalHasCredentials, setGcalHasCredentials] = useState(false);
  const [gcalConnecting, setGcalConnecting] = useState(false);
  const [gcalEnabled, setGcalEnabled] = useState(true);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const [credentialInput, setCredentialInput] = useState({ clientId: '', clientSecret: '' });
  const [showCredentialForm, setShowCredentialForm] = useState(false);

  const [plans, setPlans] = useState<CalendarPlan[]>([]);
  const [localEvents, setLocalEvents] = useState<CalendarEvent[]>([]);
  const [allEvents, setAllEvents] = useState<CalendarEvent[]>([]);
  const [editingEvent, setEditingEvent] = useState<EditingEvent | null>(null);
  const [gcalPopoverEvent, setGcalPopoverEvent] = useState<{ event: GoogleCalendarEvent; anchorX: number; anchorY: number } | null>(null);

  const editingSnapshotRef = useRef<CalendarEvent | null>(null);
  const newEventIdRef = useRef<string | null>(null);

  const weekStart = startOfWeek(anchorDate);

  const viewRange = useMemo((): [string, string] => {
    if (view === 'week') {
      return [weekStart.toISOString(), addDays(weekStart, 7).toISOString()];
    }
    const monthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const monthEnd = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
    return [monthStart.toISOString(), monthEnd.toISOString()];
  }, [view, weekStart.getTime(), anchorDate.getFullYear(), anchorDate.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.googleCalendarAPI.status().then(({ connected, hasCredentials }) => {
      setGcalConnected(connected);
      setGcalHasCredentials(hasCredentials);
    });
    window.calendarAPI.listPlans().then(setPlans);
  }, []);

  const refreshLocalEvents = useCallback(() => {
    window.calendarAPI.listEvents({ from: viewRange[0], to: viewRange[1] }).then(setLocalEvents);
  }, [viewRange[0], viewRange[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAllEvents = useCallback(() => {
    window.calendarAPI.listEvents().then(setAllEvents);
  }, []);

  useEffect(() => { refreshLocalEvents(); }, [refreshLocalEvents]);
  useEffect(() => { refreshAllEvents(); }, [refreshAllEvents]);

  useEffect(() => {
    if (!gcalConnected) return;
    window.googleCalendarAPI.fetchEvents(viewRange[0], viewRange[1])
      .then(setGoogleEvents)
      .catch(() => setGoogleEvents([]));
  }, [gcalConnected, viewRange[0], viewRange[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGcalConnect() {
    setGcalConnecting(true);
    try {
      await window.googleCalendarAPI.connect();
      setGcalConnected(true);
    } finally {
      setGcalConnecting(false);
    }
  }

  async function handleGcalDisconnect() {
    await window.googleCalendarAPI.disconnect();
    setGcalConnected(false);
    setGoogleEvents([]);
  }

  async function handleSaveCredentials() {
    const { clientId, clientSecret } = credentialInput;
    if (!clientId.trim() || !clientSecret.trim()) return;
    await window.googleCalendarAPI.setCredentials(clientId.trim(), clientSecret.trim());
    setGcalHasCredentials(true);
    setShowCredentialForm(false);
    setCredentialInput({ clientId: '', clientSecret: '' });
  }

  function navigate(dir: -1 | 1) {
    setAnchorDate(prev => {
      if (view === 'week') return addDays(prev, dir * 7);
      const d = new Date(prev);
      d.setMonth(d.getMonth() + dir);
      return d;
    });
  }

  const dateRangeLabel = view === 'week'
    ? formatWeekRange(weekStart)
    : formatMonthYear(anchorDate);

  const startResize = useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const startX = e.clientX;
    const startLeft = leftWidthRef.current;
    const startRight = rightWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const deltaPct = ((moveEvent.clientX - startX) / containerWidth) * 100;
      if (side === 'left') {
        const max = 100 - startRight - MIN_PANEL_WIDTH * 2;
        setLeftWidth(Math.max(MIN_PANEL_WIDTH, Math.min(startLeft + deltaPct, max)));
      } else {
        const max = 100 - startLeft - MIN_PANEL_WIDTH * 2;
        setRightWidth(Math.max(MIN_PANEL_WIDTH, Math.min(startRight - deltaPct, max)));
      }
    };

    const onMouseUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Block drag when any popover is open
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = editingEvent !== null || gcalPopoverEvent !== null;

  const plansRef = useRef(plans);
  plansRef.current = plans;

  const handleSelectionCommit = useCallback(async (startAt: Date, endAt: Date, anchorX: number, anchorY: number) => {
    const color = nextAutoColor(plansRef.current.map(p => p.color));
    const event = await window.calendarAPI.createEvent({
      name: 'New event',
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      plan_id: null,
      status: 'active',
      color,
    });
    setLocalEvents(prev => [...prev, event]);
    setAllEvents(prev => [...prev, event]);
    editingSnapshotRef.current = event;
    newEventIdRef.current = event.id;
    setEditingEvent({ event, anchorX, anchorY });
  }, []);

  const handleEventClick = useCallback((event: CalendarEvent, anchorX: number, anchorY: number) => {
    editingSnapshotRef.current = event;
    setEditingEvent({ event, anchorX, anchorY });
  }, []);

  // Optimistic status preview: immediately reflect status toggle in the calendar view
  const handleStatusPreview = useCallback((status: 'active' | 'inactive') => {
    const snap = editingSnapshotRef.current;
    if (!snap) return;
    setLocalEvents(prev => prev.map(e => e.id === snap.id ? { ...e, status } : e));
  }, []);

  // Optimistic color preview: immediately reflect color/plan change in the calendar view
  const handleColorPreview = useCallback((color: string) => {
    const snap = editingSnapshotRef.current;
    if (!snap) return;
    setLocalEvents(prev => prev.map(e => e.id === snap.id ? { ...e, color } : e));
  }, []);

  const handleModalClose = useCallback(() => {
    const snap = editingSnapshotRef.current;
    const newId = newEventIdRef.current;
    newEventIdRef.current = null;
    if (snap && newId === snap.id) {
      window.calendarAPI.deleteEvent(snap.id);
      setLocalEvents(prev => prev.filter(e => e.id !== snap.id));
      setAllEvents(prev => prev.filter(e => e.id !== snap.id));
    } else if (snap) {
      setLocalEvents(prev => prev.map(e => e.id === snap.id ? snap : e));
    }
    setEditingEvent(null);
  }, []);

  async function handleSave(id: string, updates: UpdateEventData) {
    newEventIdRef.current = null;
    const updated = await window.calendarAPI.updateEvent(id, updates);
    if (updated) {
      editingSnapshotRef.current = updated;
      setLocalEvents(prev => prev.map(e => e.id === id ? updated : e));
      setAllEvents(prev => prev.map(e => e.id === id ? updated : e));
    }
    window.calendarAPI.listPlans().then(setPlans);
  }

  const handleEventDrop = useCallback(async (event: CalendarEvent, newStartAt: Date, newEndAt: Date) => {
    const optimistic = { ...event, start_at: newStartAt.toISOString(), end_at: newEndAt.toISOString() };
    setLocalEvents(prev => prev.map(e => e.id === event.id ? optimistic : e));
    setAllEvents(prev => prev.map(e => e.id === event.id ? optimistic : e));
    const updated = await window.calendarAPI.updateEvent(event.id, {
      start_at: newStartAt.toISOString(),
      end_at: newEndAt.toISOString(),
    });
    if (updated) {
      setLocalEvents(prev => prev.map(e => e.id === event.id ? updated : e));
      setAllEvents(prev => prev.map(e => e.id === event.id ? updated : e));
    }
  }, []);

  async function handleDelete(id: string) {
    await window.calendarAPI.deleteEvent(id);
    editingSnapshotRef.current = null; // prevent revert on close
    setLocalEvents(prev => prev.filter(e => e.id !== id));
    setAllEvents(prev => prev.filter(e => e.id !== id));
  }

  return (
    <div className="calendarPage" ref={containerRef}>
      <div className="calendarPanel" style={{ width: `${leftWidth}%` }}>
        <div className="calendarPanelSection">
          <CalendarSidebar
            plans={plans}
            allEvents={allEvents}
            onEventClick={(event, anchorX, anchorY) => {
              editingSnapshotRef.current = event;
              setEditingEvent({ event, anchorX, anchorY });
            }}
            onReassign={async (eventId, newPlanId) => {
              const planColor = newPlanId ? plans.find(p => p.id === newPlanId)?.color : undefined;
              const updates = { plan_id: newPlanId, ...(planColor ? { color: planColor } : {}) };
              const updated = await window.calendarAPI.updateEvent(eventId, updates);
              if (updated) {
                setAllEvents(prev => prev.map(e => e.id === eventId ? updated : e));
                setLocalEvents(prev => prev.map(e => e.id === eventId ? updated : e));
              }
            }}
            onDeletePlan={async (planId, deleteEvents) => {
              if (deleteEvents) {
                const toDelete = allEvents.filter(e => e.plan_id === planId);
                await Promise.all(toDelete.map(e => window.calendarAPI.deleteEvent(e.id)));
                setAllEvents(prev => prev.filter(e => e.plan_id !== planId));
                setLocalEvents(prev => prev.filter(e => e.plan_id !== planId));
              } else {
                const planEventIds = new Set(allEvents.filter(e => e.plan_id === planId).map(e => e.id));
                await Promise.all([...planEventIds].map(id => window.calendarAPI.updateEvent(id, { plan_id: null })));
                setAllEvents(prev => prev.map(e => planEventIds.has(e.id) ? { ...e, plan_id: null } : e));
                setLocalEvents(prev => prev.map(e => planEventIds.has(e.id) ? { ...e, plan_id: null } : e));
              }
              await window.calendarAPI.deletePlan(planId);
              setPlans(prev => prev.filter(p => p.id !== planId));
            }}
            onCreateGroup={async (name, color) => {
              const plan = await window.calendarAPI.createPlan({ name, color });
              setPlans(prev => [...prev, plan]);
            }}
          />
        </div>
        <div className="calendarPanelSection" />
      </div>
      <div className="calendarResizeHandle" onMouseDown={startResize('left')} />
      <div className="calendarContainer" style={{ flex: 1, minWidth: 0 }}>
        <div className="calendarControls">
          <div className="calendarControlsLeft">
            <div className="calendarNavButtons">
              <button className="calendarNavButton" onClick={() => navigate(-1)} aria-label="Previous">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="calendarNavIcon">
                  <path d="M9 11L5 7L9 3" stroke="#6B6B66" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="calendarDateRange">
                <div className="calendarDateText">{dateRangeLabel}</div>
              </div>
              <button className="calendarNavButton" onClick={() => navigate(1)} aria-label="Next">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="calendarNavIcon">
                  <path d="M5 3L9 7L5 11" stroke="#6B6B66" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <button className="calendarTodayButton" onClick={() => setAnchorDate(new Date())}>
              <div className="calendarTodayText">Today</div>
            </button>
          </div>

          <div className="calendarViewToggle">
            <button
              className={view === 'week' ? 'calendarViewOptionActive' : 'calendarViewOption'}
              onClick={() => setView('week')}
            >
              <div className={view === 'week' ? 'calendarViewTextActive' : 'calendarViewText'}>Week</div>
            </button>
            <button
              className={view === 'month' ? 'calendarViewOptionActive' : 'calendarViewOption'}
              onClick={() => setView('month')}
            >
              <div className={view === 'month' ? 'calendarViewTextActive' : 'calendarViewText'}>Month</div>
            </button>
          </div>
        </div>

        {view === 'week'
          ? <WeekView
              weekStart={weekStart}
              today={today}
              googleEvents={gcalEnabled ? googleEvents : []}
              localEvents={localEvents}
              onSelectionCommit={handleSelectionCommit}
              onEventClick={handleEventClick}
              onGcalEventClick={(ev, x, y) => setGcalPopoverEvent({ event: ev, anchorX: x, anchorY: y })}
              onEventDrop={handleEventDrop}
              blocked={popoverOpenRef}
            />
          : <MonthView
              anchorDate={anchorDate}
              today={today}
              googleEvents={gcalEnabled ? googleEvents : []}
              localEvents={localEvents}
              onSelectionCommit={handleSelectionCommit}
              onEventClick={handleEventClick}
              onGcalEventClick={(ev, x, y) => setGcalPopoverEvent({ event: ev, anchorX: x, anchorY: y })}
              onEventDrop={handleEventDrop}
              onMoreClick={date => { setAnchorDate(date); setView('week'); }}
              blocked={popoverOpenRef}
            />
        }

        {gcalConnected ? (
          <div className="gcalBar gcalBarConnected">
            <span className="gcalBarDot" style={gcalEnabled ? {} : { backgroundColor: '#C8C4BC' }} />
            <span className="gcalBarLabel">
              Google Calendar {gcalEnabled ? 'connected' : 'hidden'}
            </span>
            <button
              className="gcalBarButton"
              onClick={() => setGcalEnabled(e => !e)}
            >
              {gcalEnabled ? 'Hide' : 'Show'}
            </button>
            <button className="gcalBarButton" onClick={handleGcalDisconnect}>Disconnect</button>
          </div>
        ) : showCredentialForm ? (
          <div className="gcalBar gcalCredentialForm">
            <input
              className="gcalCredentialInput"
              placeholder="Client ID"
              value={credentialInput.clientId}
              onChange={e => setCredentialInput(p => ({ ...p, clientId: e.target.value }))}
            />
            <input
              className="gcalCredentialInput"
              placeholder="Client Secret"
              type="password"
              value={credentialInput.clientSecret}
              onChange={e => setCredentialInput(p => ({ ...p, clientSecret: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && handleSaveCredentials()}
            />
            <button className="gcalBarButton gcalBarButtonPrimary" onClick={handleSaveCredentials}>
              Save
            </button>
            <button className="gcalBarButton" onClick={() => setShowCredentialForm(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="gcalBar">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="gcalBarIcon">
              <rect x="1" y="2" width="12" height="11" rx="1.5" stroke="#9B9B96" strokeWidth="1.2" />
              <path d="M1 5h12" stroke="#9B9B96" strokeWidth="1.2" />
              <path d="M4 1v2M10 1v2" stroke="#9B9B96" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            {gcalHasCredentials ? (
              <>
                <button
                  className="gcalBarButton gcalBarButtonPrimary"
                  onClick={handleGcalConnect}
                  disabled={gcalConnecting}
                >
                  {gcalConnecting ? 'Opening browser…' : 'Connect Google Calendar'}
                </button>
                <button className="gcalBarButton" onClick={() => setShowCredentialForm(true)}>
                  Edit credentials
                </button>
              </>
            ) : (
              <button
                className="gcalBarButton gcalBarButtonPrimary"
                onClick={() => setShowCredentialForm(true)}
              >
                Set up Google Calendar
              </button>
            )}
          </div>
        )}
      </div>
      <div className="calendarResizeHandle" onMouseDown={startResize('right')} />
      <div className="calendarChat" style={{ width: `${rightWidth}%` }}>
        <CalendarChat />
      </div>

      {editingEvent && (
        <EventEditPopover
          event={editingEvent.event}
          plans={plans}
          anchorX={editingEvent.anchorX}
          anchorY={editingEvent.anchorY}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={handleModalClose}
          onStatusChange={handleStatusPreview}
          onColorChange={handleColorPreview}
        />
      )}
      {gcalPopoverEvent && (
        <GcalEventPopover
          event={gcalPopoverEvent.event}
          anchorX={gcalPopoverEvent.anchorX}
          anchorY={gcalPopoverEvent.anchorY}
          onClose={() => setGcalPopoverEvent(null)}
        />
      )}
    </div>
  );
}
