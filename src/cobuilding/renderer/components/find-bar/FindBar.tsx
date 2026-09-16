/**
 * The find bar's own page component, hosted in a separate `WebContentsView`
 * (see src/cobuilding/shared/findInPage.ts for why: findInPage matches the
 * text of a page's own <input>, so a find box living in the searched page
 * would always match itself).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { FindBarAPI, FindResult } from '../../../shared/findInPage';
import { MSymbol } from '../command-desk/MSymbol';
import { applyResult, applyText, formatCount, initialFindBarState, type FindBarState } from './findBarState';

export function FindBar({ api }: { api: FindBarAPI }) {
  const [state, setState] = useState<FindBarState>(initialFindBarState);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubResult = api.onResult((result: FindResult) => {
      setState((s) => applyResult(s, result));
    });
    const unsubFocus = api.onFocus(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      unsubResult();
      unsubFocus();
    };
  }, [api]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setState((s) => applyText(s, text));
    api.query(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter') {
      e.preventDefault();
      api.step(!e.shiftKey);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      api.close(true);
      return;
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      api.step(!e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      inputRef.current?.select();
    }
  };

  const disabled = state.matches === 0;

  return (
    <div className="findBar" role="search" onKeyDown={handleKeyDown}>
      <input
        ref={inputRef}
        className="findBar__input"
        aria-label="Find in page"
        placeholder="Find in page"
        spellCheck={false}
        autoFocus
        value={state.text}
        onChange={handleChange}
      />
      <span className="findBar__count">{formatCount(state)}</span>
      <button
        type="button"
        className="cdIconBtn findBar__btn"
        aria-label="Previous match"
        disabled={disabled}
        onClick={() => api.step(false)}
      >
        <MSymbol name="keyboard_arrow_up" />
      </button>
      <button
        type="button"
        className="cdIconBtn findBar__btn"
        aria-label="Next match"
        disabled={disabled}
        onClick={() => api.step(true)}
      >
        <MSymbol name="keyboard_arrow_down" />
      </button>
      <button
        type="button"
        className="cdIconBtn findBar__btn"
        aria-label="Close"
        onClick={() => api.close(true)}
      >
        <MSymbol name="close" />
      </button>
    </div>
  );
}
