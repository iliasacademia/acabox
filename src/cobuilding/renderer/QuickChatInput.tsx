import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { QuickChatContext } from '../main/quickChat';
import './QuickChat.css';

declare global {
  interface Window {
    quickChatAPI: {
      onContext: (callback: (context: QuickChatContext) => void) => void;
      submit: (text: string) => void;
      dismiss: () => void;
      resize: (height: number) => void;
    };
  }
}

export function QuickChatInput() {
  const [text, setText] = useState('');
  const [context, setContext] = useState<QuickChatContext | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.quickChatAPI.onContext((ctx) => {
      setContext(ctx);
      setText('');
      // Focus textarea when context arrives
      setTimeout(() => textareaRef.current?.focus(), 50);
    });
  }, []);

  const updateHeight = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      // Small delay to let React re-render
      requestAnimationFrame(() => {
        const height = container.offsetHeight;
        window.quickChatAPI.resize(height);
      });
    }
  }, []);

  useEffect(() => {
    updateHeight();
  }, [text, context, updateHeight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.quickChatAPI.dismiss();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) {
        window.quickChatAPI.submit(text.trim());
        setText('');
      }
      return;
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 88)}px`;
  };

  const hasContext = context && (context.frontmostApp || context.selectedText || context.focusedElementDescription || context.focusedElementValue || context.documentUrl);

  // Determine the best "visible text" to show: selected text, or focused element value as fallback
  const visibleText = context?.selectedText || context?.focusedElementValue || null;

  return (
    <div className="quick-chat-container" ref={containerRef}>
      <div className="quick-chat-input-row">
        <svg className="quick-chat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <textarea
          ref={textareaRef}
          className="quick-chat-textarea"
          placeholder="Ask anything..."
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
        />
      </div>

      {hasContext && (
        <div className="quick-chat-context">
          {context.frontmostApp && (
            <div className="quick-chat-context-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              Context from: {context.frontmostApp}
              {context.documentUrl && (
                <span className="quick-chat-document-url"> — {context.documentUrl}</span>
              )}
              {context.focusedElementRole && context.focusedElementDescription && (
                <span> — {context.focusedElementDescription} ({context.focusedElementRole})</span>
              )}
            </div>
          )}
          {visibleText && (
            <div className="quick-chat-selected-text">
              {context.selectedText ? 'Selected: ' : 'Content: '}
              {visibleText}
            </div>
          )}
        </div>
      )}

      <div className="quick-chat-hint">
        <span><kbd>Enter</kbd> Send</span>
        <span><kbd>Shift+Enter</kbd> New line</span>
        <span><kbd>Esc</kbd> Dismiss</span>
      </div>
    </div>
  );
}
