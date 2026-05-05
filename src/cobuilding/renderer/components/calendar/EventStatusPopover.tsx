import React, { useEffect, useRef, useState } from 'react';
import './EventStatusPopover.css';

interface Props {
  anchorX: number;
  anchorY: number;
  onCommit: (status: 'active' | 'inactive') => void;
  onClose: () => void;
}

const OPTIONS: { label: string; sublabel: string; value: 'active' | 'inactive' }[] = [
  { label: 'Active', sublabel: 'Shows on calendar', value: 'active' },
  { label: 'Background', sublabel: 'Tracked but subtle', value: 'inactive' },
];

export function EventStatusPopover({ anchorX, anchorY, onCommit, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        setFocusIdx(i => (e.shiftKey ? (i - 1 + OPTIONS.length) % OPTIONS.length : (i + 1) % OPTIONS.length));
        return;
      }
      if (e.key === 'Enter') {
        onCommit(OPTIONS[focusIdx].value);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusIdx, onCommit, onClose]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [onClose]);

  const popoverWidth = 200;
  const popoverHeight = 120;
  const left = Math.min(anchorX, window.innerWidth - popoverWidth - 8);
  const top = Math.min(anchorY, window.innerHeight - popoverHeight - 8);

  return (
    <div ref={containerRef} className="espOverlay" style={{ left, top }}>
      <div className="espTitle">Event status</div>
      <div className="espList">
        {OPTIONS.map((opt, i) => (
          <button
            key={opt.value}
            className={`espPill${focusIdx === i ? ' espPillFocused' : ''}`}
            onClick={() => onCommit(opt.value)}
            onMouseEnter={() => setFocusIdx(i)}
          >
            <span className="espPillLabel">{opt.label}</span>
            <span className="espPillSub">{opt.sublabel}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
