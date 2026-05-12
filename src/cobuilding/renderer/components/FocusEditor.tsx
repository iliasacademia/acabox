import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FOCUS_MD } from '../../shared/paths';

export const FocusEditor: React.FC = () => {
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    window.academiaFileAPI.read(FOCUS_MD).then(({ content: c }) => {
      setContent(c);
      setSavedContent(c);
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await window.academiaFileAPI.write(FOCUS_MD, content);
      setSavedContent(content);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [content]);

  const handleReset = useCallback(async () => {
    await window.academiaFileAPI.write(FOCUS_MD, '');
    setContent('');
    setSavedContent('');
  }, []);

  const hasChanges = content !== (savedContent ?? '');

  return (
    <div className="focusEditor">
      <div className="focusEditor__header">
        <h2 className="focusEditor__title">Focus</h2>
        <p className="focusEditor__description">
          Describe your research focus below. This is used to filter your activity
          summaries and reactions — only activities relevant to your focus will be
          kept and reacted to.
        </p>
      </div>
      <textarea
        className="focusEditor__textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="You are focused on the field of biology..."
      />
      <div className="focusEditor__actions">
        <button
          className="focusEditor__save"
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
        </button>
        {savedContent && (
          <button
            className="focusEditor__reset"
            onClick={handleReset}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
};
