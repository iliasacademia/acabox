import React from 'react';

/**
 * One row on the Knowledge page — a skill, or a memory file.
 *
 * The markup is `.connectorRow` from ConnectorsSettings.css, deliberately and
 * verbatim. Skills, memories and connectors are three things the user attaches
 * to Claude; if they looked like three different products the page would be
 * teaching a distinction that does not exist. Only the classes this file adds
 * (`knowledgeRow__*`) live in knowledge.css.
 *
 * Nothing here invents a value. A chip is rendered only when the caller has one
 * to give — there is no "Unknown" fallback and no default status dot, because
 * a dot that is always present carries no information and a fabricated one is
 * a lie about a system the user is trying to understand.
 */

export interface RowChip {
  label: string;
  /** `off` dims, `warn` reds, `good` greens. Absent = the neutral outline chip. */
  tone?: 'off' | 'warn' | 'good';
  title?: string;
}

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

export function KnowledgeRow({
  name,
  alias,
  chips,
  description,
  meta,
  actions,
  dimmed,
  onOpen,
}: {
  name: string;
  /** Frontmatter `name` when it disagrees with the id. A declared alias only. */
  alias?: string;
  chips?: RowChip[];
  description?: string;
  /** Mono meta line. A node, so it can carry the origin-chat link. */
  meta?: React.ReactNode;
  actions?: RowAction[];
  dimmed?: boolean;
  /** Clicking the name opens the detail modal. */
  onOpen?: () => void;
}) {
  return (
    <div className={`connectorRow${dimmed ? ' connectorRow--off' : ''}`}>
      <div className="connectorRow__main">
        <div className="connectorRow__name">
          {onOpen ? (
            <button type="button" className="knowledgeRow__nameBtn" onClick={onOpen}>
              {name}
            </button>
          ) : (
            <span>{name}</span>
          )}
          {alias && (
            <span
              className="knowledgeRow__alias"
              title="The skill's frontmatter declares this name; the directory name is what Claude calls."
            >
              {alias}
            </span>
          )}
          {chips?.map((chip) => (
            <span
              key={chip.label}
              className={`connectorRow__chip${chip.tone ? ` knowledgeChip--${chip.tone}` : ''}`}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
        </div>
        {description && (
          // Clamped, with the whole string on hover and in the detail modal.
          // Roster descriptions run to 900+ characters (xlsx is 941), which at
          // full length buries every other row on the page.
          <div className="connectorRow__status knowledgeRow__desc" title={description}>
            {description}
          </div>
        )}
        {meta && <div className="connectorRow__target">{meta}</div>}
      </div>
      {actions && actions.length > 0 && (
        <div className="connectorRow__actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`connectorBtn${a.danger ? ' connectorBtn--danger' : ''}`}
              onClick={a.onClick}
              disabled={a.disabled}
              title={a.title}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
