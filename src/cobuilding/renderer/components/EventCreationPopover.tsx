import React, { useState, useEffect, useRef, useCallback } from 'react';
import './EventCreationPopover.css';
import { PLAN_COLORS, nextAutoColor } from '../calendarColors';
import type { CalendarPlan } from '../../shared/types';

interface Props {
  plans: CalendarPlan[];
  anchorX: number;
  anchorY: number;
  onCommit: (planId: string | null, color: string) => void;
  onClose: () => void;
}

export function EventCreationPopover({ plans, anchorX, anchorY, onCommit, onClose }: Props) {
  const [focusIdx, setFocusIdx] = useState(0);
  const [showNewPlan, setShowNewPlan] = useState(false);
  const [newPlanName, setNewPlanName] = useState('');
  const [selectedFamily, setSelectedFamily] = useState(0);
  const [selectedShade, setSelectedShade] = useState<keyof typeof PLAN_COLORS[0]['shades']>(600);
  const [expandedFamily, setExpandedFamily] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // sorted by updated_at desc (plans already come sorted by created_at; for recency we just reverse)
  const sortedPlans = [...plans].reverse();
  // items: sortedPlans + "No plan" + "New plan"
  const totalItems = sortedPlans.length + 2;
  const noPlanIdx = sortedPlans.length;
  const newPlanIdx = sortedPlans.length + 1;

  const autoColor = nextAutoColor(plans.map(p => p.color));

  useEffect(() => {
    if (showNewPlan && inputRef.current) {
      inputRef.current.focus();
      if (!newPlanName) {
        const shadeKeys = Object.keys(PLAN_COLORS[selectedFamily].shades).map(Number) as Array<keyof typeof PLAN_COLORS[0]['shades']>;
        setSelectedShade(600 as keyof typeof PLAN_COLORS[0]['shades']);
        const fam = plans.map(p => p.color);
        const nextFamIdx = PLAN_COLORS.findIndex(f => !fam.includes(f.shades[600]));
        setSelectedFamily(nextFamIdx >= 0 ? nextFamIdx : 0);
      }
    }
  }, [showNewPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (showNewPlan) return;
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
  }, [focusIdx, showNewPlan, totalItems]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (idx === newPlanIdx) {
      setShowNewPlan(true);
      setFocusIdx(newPlanIdx);
      return;
    }
    if (idx === noPlanIdx) {
      onCommit(null, autoColor);
      return;
    }
    const plan = sortedPlans[idx];
    onCommit(plan.id, plan.color);
  }

  async function handleCreatePlan() {
    const name = newPlanName.trim();
    if (!name || creating) return;
    const color = PLAN_COLORS[selectedFamily].shades[selectedShade];
    setCreating(true);
    try {
      const plan = await window.calendarAPI.createPlan({ name, color });
      onCommit(plan.id, color);
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
      <div className="ecpTitle">Add to plan</div>

      {!showNewPlan ? (
        <div className="ecpList">
          {sortedPlans.map((plan, i) => (
            <button
              key={plan.id}
              className={`ecpPill${focusIdx === i ? ' ecpPillFocused' : ''}`}
              onClick={() => handleSelect(i)}
              onMouseEnter={() => setFocusIdx(i)}
            >
              <span className="ecpColorDot" style={{ backgroundColor: plan.color }} />
              <span className="ecpPillLabel">{plan.name}</span>
            </button>
          ))}

          <button
            className={`ecpPill${focusIdx === noPlanIdx ? ' ecpPillFocused' : ''}`}
            onClick={() => handleSelect(noPlanIdx)}
            onMouseEnter={() => setFocusIdx(noPlanIdx)}
          >
            <span className="ecpColorDotEmpty" />
            <span className="ecpPillLabel ecpPillLabelMuted">No plan</span>
          </button>

          <button
            className={`ecpPill${focusIdx === newPlanIdx ? ' ecpPillFocused' : ''}`}
            onClick={() => handleSelect(newPlanIdx)}
            onMouseEnter={() => setFocusIdx(newPlanIdx)}
          >
            <span className="ecpPlusDot">+</span>
            <span className="ecpPillLabel ecpPillLabelMuted">New plan</span>
          </button>
        </div>
      ) : (
        <div className="ecpNewPlan">
          <input
            ref={inputRef}
            className="ecpInput"
            placeholder="Plan name"
            value={newPlanName}
            onChange={e => setNewPlanName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleCreatePlan(); }
              if (e.key === 'Escape') { setShowNewPlan(false); }
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
            <button className="ecpCancelBtn" onClick={() => setShowNewPlan(false)}>Cancel</button>
            <button
              className="ecpCreateBtn"
              onClick={handleCreatePlan}
              disabled={!newPlanName.trim() || creating}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
