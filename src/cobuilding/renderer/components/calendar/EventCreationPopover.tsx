import React, { useState, useEffect, useRef, useCallback } from 'react';
import './EventCreationPopover.css';
import { PLAN_COLORS, nextAutoColor } from './calendarColors';
import type { CalendarGroup } from '../../shared/types';

interface Props {
  groups: CalendarGroup[];
  anchorX: number;
  anchorY: number;
  onCommit: (groupId: string | null, color: string) => void;
  onClose: () => void;
}

export function EventCreationPopover({ groups, anchorX, anchorY, onCommit, onClose }: Props) {
  const [focusIdx, setFocusIdx] = useState(0);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedFamily, setSelectedFamily] = useState(0);
  const [selectedShade, setSelectedShade] = useState<keyof typeof PLAN_COLORS[0]['shades']>(600);
  const [expandedFamily, setExpandedFamily] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // sorted by updated_at desc (groups already come sorted by created_at; for recency we just reverse)
  const sortedGroups = [...groups].reverse();
  // items: sortedGroups + "No group" + "New group"
  const totalItems = sortedGroups.length + 2;
  const noGroupIdx = sortedGroups.length;
  const newGroupIdx = sortedGroups.length + 1;

  const autoColor = nextAutoColor(groups.map(g => g.color));

  useEffect(() => {
    if (showNewGroup && inputRef.current) {
      inputRef.current.focus();
      if (!newGroupName) {
        const shadeKeys = Object.keys(PLAN_COLORS[selectedFamily].shades).map(Number) as Array<keyof typeof PLAN_COLORS[0]['shades']>;
        setSelectedShade(600 as keyof typeof PLAN_COLORS[0]['shades']);
        const fam = groups.map(g => g.color);
        const nextFamIdx = PLAN_COLORS.findIndex(f => !fam.includes(f.shades[600]));
        setSelectedFamily(nextFamIdx >= 0 ? nextFamIdx : 0);
      }
    }
  }, [showNewGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (showNewGroup) return;
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        setFocusIdx(i => (e.shiftKey ? (i - 1 + totalItems) % totalItems : (i + 1) % totalItems));
        return;
      }
      if (e.key === 'Enter') {
        handleSelect(focusIdx);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusIdx, showNewGroup, totalItems]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [onClose]);

  function handleSelect(idx: number) {
    if (idx === newGroupIdx) {
      setShowNewGroup(true);
      setFocusIdx(newGroupIdx);
      return;
    }
    if (idx === noGroupIdx) {
      onCommit(null, autoColor);
      return;
    }
    const group = sortedGroups[idx];
    onCommit(group.id, group.color);
  }

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name || creating) return;
    const color = PLAN_COLORS[selectedFamily].shades[selectedShade];
    setCreating(true);
    try {
      const group = await window.calendarAPI.createGroup({ name, color });
      onCommit(group.id, color);
    } finally {
      setCreating(false);
    }
  }

  // Position: keep within viewport
  const popoverWidth = 220;
  const popoverHeight = 300;
  const left = Math.min(anchorX, window.innerWidth - popoverWidth - 8);
  const top = Math.min(anchorY, window.innerHeight - popoverHeight - 8);

  return (
    <div
      ref={containerRef}
      className="ecpOverlay"
      style={{ left, top }}
    >
      <div className="ecpTitle">Add to group</div>

      {!showNewGroup ? (
        <div className="ecpList">
          {sortedGroups.map((group, i) => (
            <button
              key={group.id}
              className={`ecpPill${focusIdx === i ? ' ecpPillFocused' : ''}`}
              onClick={() => handleSelect(i)}
              onMouseEnter={() => setFocusIdx(i)}
            >
              <span className="ecpColorDot" style={{ backgroundColor: group.color }} />
              <span className="ecpPillLabel">{group.name}</span>
            </button>
          ))}

          <button
            className={`ecpPill${focusIdx === noGroupIdx ? ' ecpPillFocused' : ''}`}
            onClick={() => handleSelect(noGroupIdx)}
            onMouseEnter={() => setFocusIdx(noGroupIdx)}
          >
            <span className="ecpColorDotEmpty" />
            <span className="ecpPillLabel ecpPillLabelMuted">No group</span>
          </button>

          <button
            className={`ecpPill${focusIdx === newGroupIdx ? ' ecpPillFocused' : ''}`}
            onClick={() => handleSelect(newGroupIdx)}
            onMouseEnter={() => setFocusIdx(newGroupIdx)}
          >
            <span className="ecpPlusDot">+</span>
            <span className="ecpPillLabel ecpPillLabelMuted">New group</span>
          </button>
        </div>
      ) : (
        <div className="ecpNewPlan">
          <input
            ref={inputRef}
            className="ecpInput"
            placeholder="Group name"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); }
              if (e.key === 'Escape') { setShowNewGroup(false); }
            }}
          />
          <div className="ecpColorFamilies">
            {PLAN_COLORS.map((fam, fi) => (
              <div key={fam.family} className="ecpFamilyGroup">
                <button
                  className={`ecpFamilySwatch${selectedFamily === fi ? ' ecpFamilySwatchSelected' : ''}`}
                  style={{ backgroundColor: fam.shades[600] }}
                  onClick={() => {
                    setSelectedFamily(fi);
                    setSelectedShade(600 as keyof typeof PLAN_COLORS[0]['shades']);
                    setExpandedFamily(expandedFamily === fi ? null : fi);
                  }}
                  title={fam.family}
                />
                {expandedFamily === fi && (
                  <div className="ecpShadeRow">
                    {(Object.entries(fam.shades) as [string, string][]).map(([shade, color]) => (
                      <button
                        key={shade}
                        className={`ecpShadeSwatch${selectedShade === (Number(shade) as keyof typeof PLAN_COLORS[0]['shades']) && selectedFamily === fi ? ' ecpShadeSwatchSelected' : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          setSelectedFamily(fi);
                          setSelectedShade(Number(shade) as keyof typeof PLAN_COLORS[0]['shades']);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="ecpNewPlanActions">
            <button className="ecpCancelBtn" onClick={() => setShowNewGroup(false)}>Cancel</button>
            <button
              className="ecpCreateBtn"
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim() || creating}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
