import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { r } from 'codemirror-lang-r';
import { oneDark } from '@codemirror/theme-one-dark';

export interface CodeEditorHandle {
  focus: () => void;
  blur: () => void;
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  onExecute?: () => void;
  onExecuteAndAdvance?: () => void;
  onEscape?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  ({ value, onChange, language, onExecute, onExecuteAndAdvance, onEscape, onArrowUp, onArrowDown }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onExecuteRef = useRef(onExecute);
    const onExecuteAndAdvanceRef = useRef(onExecuteAndAdvance);
    const onEscapeRef = useRef(onEscape);
    const onArrowUpRef = useRef(onArrowUp);
    const onArrowDownRef = useRef(onArrowDown);

    onChangeRef.current = onChange;
    onExecuteRef.current = onExecute;
    onExecuteAndAdvanceRef.current = onExecuteAndAdvance;
    onEscapeRef.current = onEscape;
    onArrowUpRef.current = onArrowUp;
    onArrowDownRef.current = onArrowDown;

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      blur: () => viewRef.current?.contentDOM.blur(),
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const languageExtension =
        language === 'python' ? python() :
        language === 'R' || language === 'r' ? r() :
        [];

      const executeKeymap = keymap.of([
        {
          key: 'Shift-Enter',
          run: () => {
            onExecuteAndAdvanceRef.current?.();
            return true;
          },
        },
        {
          key: 'Mod-Enter',
          run: () => {
            onExecuteRef.current?.();
            return true;
          },
        },
        {
          key: 'Ctrl-Enter',
          run: () => {
            onExecuteRef.current?.();
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            onEscapeRef.current?.();
            return true;
          },
        },
        {
          key: 'ArrowUp',
          run: (view) => {
            const { state } = view;
            const mainSel = state.selection.main;
            const firstLine = state.doc.lineAt(0);
            if (mainSel.from <= firstLine.to && mainSel.empty && onArrowUpRef.current) {
              onArrowUpRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: 'ArrowDown',
          run: (view) => {
            const { state } = view;
            const mainSel = state.selection.main;
            const lastLine = state.doc.lineAt(state.doc.length);
            if (mainSel.from >= lastLine.from && mainSel.empty && onArrowDownRef.current) {
              onArrowDownRef.current();
              return true;
            }
            return false;
          },
        },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      });

      const state = EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          languageExtension,
          oneDark,
          executeKeymap,
          updateListener,
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '13px' },
            '.cm-content': { padding: '8px 0' },
            '.cm-gutters': { border: 'none' },
          }),
        ],
      });

      const view = new EditorView({
        state,
        parent: containerRef.current,
      });

      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Only recreate editor when language changes
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [language]);

    // Sync external value changes without recreating the editor
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentValue = view.state.doc.toString();
      if (currentValue !== value) {
        view.dispatch({
          changes: { from: 0, to: currentValue.length, insert: value },
        });
      }
    }, [value]);

    return <div ref={containerRef} className="notebookCodeEditor" />;
  },
);
