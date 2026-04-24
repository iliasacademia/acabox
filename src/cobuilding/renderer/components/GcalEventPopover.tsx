import React, { useEffect, useRef } from 'react';
import './EventEditPopover.css';

interface Props {
  event: GoogleCalendarEvent;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
}

const POPOVER_W = 260;

function formatDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDisplayDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function GcalEventPopover({ event, anchorX, anchorY, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Position: prefer right of click, flip left if too close to edge. Clamp vertically.
  const left = anchorX + 8 + POPOVER_W > window.innerWidth - 8
    ? anchorX - POPOVER_W - 8
    : anchorX + 8;
  const top = Math.min(Math.max(anchorY, 8), window.innerHeight - 8);

  const start = event.start.dateTime ?? event.start.date ?? '';
  const end = event.end.dateTime ?? event.end.date ?? '';
  const isAllDay = !event.start.dateTime;

  const timeLabel = isAllDay
    ? `${formatDisplayDate(start)} — all day`
    : `${formatDisplayDate(start)}, ${formatDisplayTime(start)} – ${formatDisplayTime(end)}`;

  return (
    <div ref={containerRef} className="eepOverlay gcalPopoverOverlay" style={{ left, top }}>
      <div className="gcalPopoverHeader">
        <span className="gcalPopoverTitle">{event.summary ?? 'Untitled'}</span>
        <span className="gcalPopoverBadge">G</span>
      </div>

      <div className="gcalInfoRow">
        <svg className="gcalInfoIcon" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="#9B9B96" strokeWidth="1.2" />
          <path d="M6 3v3l2 1.5" stroke="#9B9B96" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span className="eepTimeText">{timeLabel}</span>
      </div>

      {event.location && (
        <div className="gcalInfoRow">
          <svg className="gcalInfoIcon" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1a3.5 3.5 0 0 1 3.5 3.5C9.5 7.5 6 11 6 11S2.5 7.5 2.5 4.5A3.5 3.5 0 0 1 6 1z" stroke="#9B9B96" strokeWidth="1.2" />
            <circle cx="6" cy="4.5" r="1.2" stroke="#9B9B96" strokeWidth="1.1" />
          </svg>
          <span className="eepTimeText gcalInfoText">{event.location}</span>
        </div>
      )}

      {event.organizer && (
        <div className="gcalInfoRow">
          <svg className="gcalInfoIcon" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="4" r="2.2" stroke="#9B9B96" strokeWidth="1.2" />
            <path d="M1.5 10.5c0-2.485 2.015-4 4.5-4s4.5 1.515 4.5 4" stroke="#9B9B96" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="eepTimeText gcalInfoText">{event.organizer.displayName ?? event.organizer.email}</span>
        </div>
      )}

      {event.description && (
        <div className="gcalPopoverDesc">{event.description}</div>
      )}

      <div className="eepFooter">
        <span className="gcalPopoverSource">From Google Calendar</span>
        <button className="eepSaveBtn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
