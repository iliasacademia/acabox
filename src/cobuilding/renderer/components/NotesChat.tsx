import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  useLocalRuntime,
  AssistantRuntimeProvider,
  useAuiState,
} from '@assistant-ui/react';
import { Thread } from './assistant-ui/thread';
import { useNotesChatAdapter } from '../notesChatAdapter';
import { useNotesHistoryAdapter } from '../notesHistoryAdapter';
import './NotesChat.css';

export function NotesChat({ dayFile }: { dayFile: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const streamingRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  const handleStreamingChange = useCallback((streaming: boolean) => {
    streamingRef.current = streaming;
    if (!streaming && pendingRefreshRef.current) {
      pendingRefreshRef.current = false;
      setRefreshKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    const cleanupMessage = window.notesAPI.onAssistantMessage((data) => {
      if (data.dayFile === dayFile) {
        if (streamingRef.current) {
          pendingRefreshRef.current = true;
        } else {
          setRefreshKey((k) => k + 1);
        }
      }
    });

    const cleanupAnalyzing = window.notesAPI.onAssistantAnalyzing((data) => {
      if (data.dayFile === dayFile) {
        setAnalyzing(data.analyzing);
      }
    });

    return () => {
      cleanupMessage();
      cleanupAnalyzing();
    };
  }, [dayFile]);

  return (
    <div className="notesChat">
      <NotesChatInner
        key={`${dayFile}-${refreshKey}`}
        dayFile={dayFile}
        analyzing={analyzing}
        onStreamingChange={handleStreamingChange}
      />
    </div>
  );
}

function NotesChatInner({
  dayFile,
  analyzing,
  onStreamingChange,
}: {
  dayFile: string;
  analyzing: boolean;
  onStreamingChange: (streaming: boolean) => void;
}) {
  const chatAdapter = useNotesChatAdapter(dayFile);
  const history = useNotesHistoryAdapter(dayFile);
  const runtime = useLocalRuntime(chatAdapter, { adapters: { history } });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <StreamingTracker onStreamingChange={onStreamingChange} />
      {analyzing && (
        <div className="notesChat__analyzing">
          <span className="notesChat__analyzingDot" />
          Analyzing transcription...
        </div>
      )}
      <Thread />
    </AssistantRuntimeProvider>
  );
}

function StreamingTracker({ onStreamingChange }: { onStreamingChange: (streaming: boolean) => void }) {
  const isRunning = useAuiState((s: any) => s.thread.isRunning);
  useEffect(() => {
    onStreamingChange(isRunning);
  }, [isRunning, onStreamingChange]);
  return null;
}
