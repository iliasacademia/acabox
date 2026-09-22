import React, { useEffect, useMemo, useState, type FC } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { MSymbol } from '../command-desk/MSymbol';
import { useToolElapsed } from '../../progressStore';
import { formatToolSeconds, getToolCardDisplay } from './tool-card-display';
import {
  finalAnswerStart,
  isFailed,
  isInstallCommand,
  isOutcomePart,
  segmentParts,
  summarizeSteps,
  turnFoldLabel,
  type PartLite,
} from './turnSteps';

/**
 * Renders an assistant message's parts with the steps collapsed — layout rules
 * and their reasons live in `turnSteps.ts`; this file is the React half.
 *
 * Parts are rendered one by one through `MessagePrimitive.PartByIndex` rather
 * than `MessagePrimitive.Parts`, because the fold has to split a message at an
 * index (work before the final answer, answer after), and the library's own
 * grouping has no notion of that split.
 */

type PartComponents = React.ComponentProps<typeof MessagePrimitive.PartByIndex>['components'];

/**
 * The runtime part reduced to what layout needs. Deliberately no `text` or
 * `args`: this selector runs on every streamed token for every mounted
 * message, and a Write's args can be a whole file.
 */
function toLite(p: any): PartLite {
  const lite: PartLite = { type: p?.type ?? 'unknown' };
  if (p?.type === 'tool-call') {
    lite.toolName = p.toolName;
    lite.toolCallId = p.toolCallId;
    lite.isError = p.isError === true;
    if (p.toolName === 'Bash') lite.install = isInstallCommand(p.args);
  }
  if (p?.type === 'text') lite.blank = (p.text ?? '').trim() === '';
  if (p?.status?.type) lite.status = p.status.type;
  if (p?.status?.reason) lite.statusReason = p.status.reason;
  return lite;
}

/**
 * Parts as `PartLite[]`, via a JSON string so the store selector returns a
 * primitive — a fresh array per call would make `useSyncExternalStore` see a
 * change on every read and re-render forever.
 */
function usePartsLite(): PartLite[] {
  const json = useAuiState((s: any) => JSON.stringify((s.message.parts ?? []).map(toLite))) as string;
  return useMemo(() => JSON.parse(json) as PartLite[], [json]);
}

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i);

/* ── Running step: name, target, and a clock ─────────────────────── */

/** Seconds since this component mounted, ticking once a second. */
function useSecondsSinceMount(): number {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.floor((now - started) / 1000);
}

const RunningStep: FC<{ index: number; toolCallId: string }> = ({ index, toolCallId }) => {
  // One string out of the selector (name + args + icon), computed from the
  // full part here because only the running step needs its arguments.
  const packed = useAuiState((s: any) => {
    const p = s.message.parts?.[index];
    if (!p || p.type !== 'tool-call') return '';
    const d = getToolCardDisplay(p.toolName, p.args, p.argsText);
    return `${d.icon}\u0000${d.name}\u0000${d.args}`;
  }) as string;
  const [icon, name, args] = packed.split('\u0000');
  // The SDK reports progress only for long-running tools; the local clock
  // covers the rest, so every running step shows how long it has been going.
  const reported = useToolElapsed(toolCallId);
  const local = useSecondsSinceMount();
  const seconds = reported ?? local;

  return (
    <>
      <span className="cdDot cdDot--busy cdDot--pulse" />
      {icon && <MSymbol name={icon} size={15} className="cdSteps__icon" />}
      <span className="cdSteps__name">{name}</span>
      <span className="cdSteps__args">{args}</span>
      <span className="cdSteps__meta">{formatToolSeconds(seconds)}</span>
    </>
  );
};

/* ── A run of steps between two pieces of prose ──────────────────── */

const StepGroup: FC<{
  parts: PartLite[];
  start: number;
  end: number;
  /** This run is the tail of a turn still in progress. */
  live: boolean;
  components: PartComponents;
}> = ({ parts, start, end, live, components }) => {
  const indices = range(start, end).filter((i) => !(parts[i].type === 'text' && parts[i].blank));
  const outcome = indices.filter((i) => isOutcomePart(parts, i));
  const process = indices.filter((i) => !isOutcomePart(parts, i));
  const processTools = process.filter((i) => parts[i].type === 'tool-call');

  const failedCount = processTools.filter((i) => isFailed(parts[i])).length;
  const [open, setOpen] = useState(false);
  // A failure opens its group, once, when it lands — failures are never
  // folded out of sight. Closing it again afterwards is the user's call.
  useEffect(() => {
    if (failedCount > 0) setOpen(true);
  }, [failedCount > 0]);

  // Only thinking and outcome cards in this run: nothing to fold.
  if (processTools.length === 0) {
    return (
      <>
        {indices.map((i) => <MessagePrimitive.PartByIndex key={i} index={i} components={components} />)}
      </>
    );
  }

  let runningIdx = -1;
  for (const i of processTools) if (parts[i].status === 'running') runningIdx = i;

  const summary = summarizeSteps(processTools.map((i) => parts[i]));
  const count = processTools.length;

  return (
    <>
      <div className={`cdSteps${open ? ' cdSteps--open' : ''}`}>
        <button
          type="button"
          className="cdSteps__row"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <MSymbol name={open ? 'expand_more' : 'chevron_right'} size={16} className="cdSteps__chevron" />
          {runningIdx >= 0 ? (
            <RunningStep
              key={parts[runningIdx].toolCallId}
              index={runningIdx}
              toolCallId={parts[runningIdx].toolCallId ?? ''}
            />
          ) : (
            <>
              <span
                className={`cdDot ${failedCount > 0 ? 'cdDot--error' : live ? 'cdDot--busy cdDot--pulse' : 'cdDot--running'}`}
              />
              <span className="cdSteps__summary">{summary}</span>
              <span className="cdSteps__meta">
                {count} {count === 1 ? 'STEP' : 'STEPS'}
                {failedCount > 0 && (
                  <span className="cdSteps__meta--error"> · {failedCount} FAILED</span>
                )}
              </span>
            </>
          )}
        </button>
        {open && (
          <div className="cdSteps__body">
            {process.map((i) => <MessagePrimitive.PartByIndex key={i} index={i} components={components} />)}
          </div>
        )}
      </div>
      {outcome.map((i) => <MessagePrimitive.PartByIndex key={i} index={i} components={components} />)}
    </>
  );
};

/* ── Prose and step runs, in order ───────────────────────────────── */

const Segments: FC<{
  parts: PartLite[];
  from: number;
  to: number;
  running: boolean;
  components: PartComponents;
}> = ({ parts, from, to, running, components }) => {
  // Segmented per slice, not over the whole message: a run of steps must not
  // straddle the fold boundary, or half of it would render twice.
  const segments = segmentParts(parts.slice(from, to));
  return (
    <>
      {segments.map((seg) => {
        if (seg.kind === 'part') {
          const i = from + seg.index;
          return <MessagePrimitive.PartByIndex key={`p${i}`} index={i} components={components} />;
        }
        const start = from + seg.start;
        const end = from + seg.end;
        return (
          <StepGroup
            key={`s${start}`}
            parts={parts}
            start={start}
            end={end}
            live={running && end === parts.length - 1}
            components={components}
          />
        );
      })}
    </>
  );
};

/* ── The whole message ───────────────────────────────────────────── */

export const AssistantParts: FC<{ components: PartComponents }> = ({ components }) => {
  const parts = usePartsLite();
  const running = useAuiState((s: any) => s.message.status?.type === 'running') as boolean;
  const workedMs = useAuiState((s: any) => {
    const v = s.message.metadata?.custom?.workedMs;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }) as number | null;
  const [expanded, setExpanded] = useState(false);

  const toolCount = parts.filter((p) => p.type === 'tool-call').length;

  // While the turn runs, and for a reply that used no tools, there is nothing
  // to fold: prose stays, step runs collapse to their one line.
  if (running || toolCount === 0) {
    return <Segments parts={parts} from={0} to={parts.length} running={running} components={components} />;
  }

  const answerStart = finalAnswerStart(parts);
  const work = range(0, answerStart - 1);
  const failedCount = work.filter((i) => isFailed(parts[i])).length;
  const outcome = work.filter((i) => isOutcomePart(parts, i));

  return (
    <>
      <div className={`cdTurnFold${expanded ? ' cdTurnFold--open' : ''}`}>
        <button
          type="button"
          className="cdTurnFold__row"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <MSymbol name={expanded ? 'expand_more' : 'chevron_right'} size={16} className="cdSteps__chevron" />
          <span className="cdTurnFold__label">{turnFoldLabel(toolCount, workedMs)}</span>
          {failedCount > 0 && <span className="cdTurnFold__failed">{failedCount} failed</span>}
        </button>
        {expanded && (
          <div className="cdTurnFold__body">
            <Segments parts={parts} from={0} to={answerStart} running={false} components={components} />
          </div>
        )}
      </div>
      {/* Results stay in view when the work is folded; when it is open they
          render in place inside it instead, so they never appear twice. */}
      {!expanded && outcome.map((i) => (
        <MessagePrimitive.PartByIndex key={`o${i}`} index={i} components={components} />
      ))}
      <Segments parts={parts} from={answerStart} to={parts.length} running={false} components={components} />
    </>
  );
};
