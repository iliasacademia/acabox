import React, { memo } from 'react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';

function parsePlanItems(args: Record<string, unknown> | undefined, argsText?: string): string[] | null {
  const source = args && Object.keys(args).length > 0 ? args : undefined;
  let resolved = source;
  if (!resolved && argsText) {
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object') {
        resolved = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  if (!resolved) return null;

  const plan = resolved.plan as string | undefined;
  if (!plan || typeof plan !== 'string') return null;

  return plan
    .split('\n')
    .map((line) => line.replace(/^[\s]*(\d+\.|[-•*])\s*/, '').trim())
    .filter(Boolean);
}

const EnterPlanModeImpl: ToolCallMessagePartComponent = ({ args, argsText }: any) => {
  const items = parsePlanItems(args, argsText);

  if (!items) {
    return (
      <div className="planList">
        <div className="planListHeader">Plan</div>
        <div className="planEmpty">Thinking through the plan…</div>
      </div>
    );
  }

  return (
    <div className="planList">
      <div className="planListHeader">Plan</div>
      {items.map((item, i) => (
        <div key={i} className="planItem">
          <span className="planItemNumber">{i + 1}</span>
          <span className="planItemContent">{item}</span>
        </div>
      ))}
    </div>
  );
};

export const EnterPlanMode = memo(EnterPlanModeImpl) as unknown as ToolCallMessagePartComponent;
EnterPlanMode.displayName = 'EnterPlanMode';
