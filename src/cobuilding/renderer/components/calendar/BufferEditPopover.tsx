import React, { useState, useEffect, useRef } from 'react';
import type { EventDependency } from '../../shared/types';

interface Props {
  dependency: EventDependency;
  anchorX: number;
  anchorY: number;
  onSave: (dep: EventDependency, newLagCurrentMs: number, newLagMinMs: number, newLagMaxMs: number | null) => Promise<void>;
  onClose: () => void;
}

function msToMinutes(ms: number) { return Math.round(ms / 60000); }
function minutesToMs(m: number) { return Math.round(m) * 60000; }

export function BufferEditPopover({ dependency, anchorX, anchorY, onSave, onClose }: Props) {
  const [currentMin, setCurrentMin] = useState(msToMinutes(dependency.lag_current_ms));
  const [minWait, setMinWait] = useState(msToMinutes(dependency.lag_min_ms));
  const [maxWait, setMaxWait] = useState(dependency.lag_max_ms !== null ? msToMinutes(dependency.lag_max_ms) : '');
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Position near anchor, staying within viewport
  const style: React.CSSProperties = {
    left: Math.min(anchorX + 8, window.innerWidth - 240),
    top: Math.min(anchorY - 8, window.innerHeight - 260),
  };

  async function handleSave() {
    const newMax = maxWait === '' ? null : minutesToMs(Number(maxWait));
    const newMin = minutesToMs(minWait);
    const newCurrent = Math.max(newMin, minutesToMs(currentMin));
    await onSave(dependency, newCurrent, newMin, newMax);
    onClose();
  }

  return (
    <div className="bufferEditPopover" style={style} ref={popoverRef}>
      <div className="bufferEditTitle">Buffer Window</div>

      <div className="bufferEditRow">
        <span className="bufferEditLabel">Current</span>
        <input
          className="bufferEditInput"
          type="number"
          min={0}
          value={currentMin}
          onChange={e => setCurrentMin(Number(e.target.value))}
        />
        <span className="bufferEditUnit">min</span>
      </div>

      <div className="bufferEditRow">
        <span className="bufferEditLabel">Min wait</span>
        <input
          className="bufferEditInput"
          type="number"
          min={0}
          value={minWait}
          onChange={e => setMinWait(Number(e.target.value))}
        />
        <span className="bufferEditUnit">min</span>
      </div>

      <div className="bufferEditRow">
        <span className="bufferEditLabel">Max wait</span>
        <input
          className="bufferEditInput"
          type="number"
          min={0}
          placeholder="∞"
          value={maxWait}
          onChange={e => setMaxWait(e.target.value === '' ? '' : Number(e.target.value))}
        />
        <span className="bufferEditUnit">min</span>
      </div>

      <div className="bufferEditActions">
        <button className="bufferEditCancel" onClick={onClose}>Cancel</button>
        <button className="bufferEditSave" onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}
