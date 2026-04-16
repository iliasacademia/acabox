import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MicIcon, SquareIcon } from 'lucide-react';
import './NotesPanel.css';

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const SPEECH_RMS_THRESHOLD = 0.02;

/** Check if the current audio level exceeds the speech threshold. */
function hasSpeech(analyser: AnalyserNode): boolean {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = (data[i] - 128) / 128; // center at 0, range -1 to 1
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return rms > SPEECH_RMS_THRESHOLD;
}


export function NotesPanel({ selectedDay }: { selectedDay: string | null }) {
  const day = selectedDay ?? todayDateString();

  const [noteContent, setNoteContent] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcribingCount, setTranscribingCount] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);

  // Load note content when day changes
  useEffect(() => {
    window.notesAPI.readDay(day).then(setNoteContent);
  }, [day]);

  // Subscribe to transcription events
  useEffect(() => {
    const cleanupTranscription = window.notesAPI.onTranscription((data) => {
      if (data.dayFile === day) {
        // Reload the full file content to stay in sync with what's on disk
        window.notesAPI.readDay(day).then(setNoteContent);
      }
      setTranscribingCount((c) => Math.max(0, c - 1));
    });

    const cleanupError = window.notesAPI.onTranscriptionError((errMsg) => {
      setError(errMsg);
      setTranscribingCount((c) => Math.max(0, c - 1));
    });

    return () => {
      cleanupTranscription();
      cleanupError();
    };
  }, [day]);

  // Auto-scroll when content updates
  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [noteContent]);

  // Records a single chunk: creates a fresh MediaRecorder on the stream,
  // records for the given duration, then resolves with the complete audio blob.
  // Each recording is a standalone file with proper WebM headers.
  // If an analyser is provided, polls for speech during recording and reports
  // whether any speech was detected.
  const recordChunk = useCallback((
    stream: MediaStream,
    durationMs: number,
    analyser: AnalyserNode | null,
  ): Promise<{ blob: Blob | null; speechDetected: boolean }> => {
    return new Promise((resolve) => {
      const recorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      const chunks: Blob[] = [];
      let speechDetected = false;

      const speechPoll = analyser
        ? setInterval(() => {
            if (hasSpeech(analyser)) speechDetected = true;
          }, 250)
        : null;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = () => {
        if (speechPoll) clearInterval(speechPoll);
        const blob = new Blob(chunks, { type: 'audio/webm' });
        resolve({
          blob: blob.size < 1000 ? null : blob,
          speechDetected: analyser ? speechDetected : true,
        });
      };

      recorder.start();
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, durationMs);
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recordingRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordingRef.current = true;
      setIsRecording(true);
      setDuration(0);

      // Set up Web Audio analyser for silence detection
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      // Record chunks in a loop using stop-and-restart so each chunk
      // is a standalone audio file with proper container headers.
      // Speech detection runs in parallel — if no speech is detected
      // during the chunk, we skip sending it to save API calls.
      const runChunkLoop = async () => {
        try {
          while (recordingRef.current && streamRef.current) {
            const { blob, speechDetected } = await recordChunk(
              streamRef.current, 5000, analyserRef.current,
            );
            if (!recordingRef.current) break;
            if (blob && speechDetected) {
              const arrayBuffer = await blob.arrayBuffer();
              const base64 = btoa(
                new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
              );
              setTranscribingCount((c) => c + 1);
              window.notesAPI.transcribeChunk(base64, day);
            }
          }
        } catch (loopErr: unknown) {
          setError(loopErr instanceof Error ? loopErr.message : 'Recording failed unexpectedly');
          stopRecording();
        }
      };
      runChunkLoop();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone access denied. Please allow microphone access in System Settings > Privacy & Security > Microphone.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to start recording');
      }
    }
  }, [day, recordChunk]);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setIsRecording(false);
  }, []);

  return (
    <div className="notesPanel">
      <div className="notesPanel__content">
        {noteContent ? (
          <div className="markdownViewRendered">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{noteContent}</ReactMarkdown>
            <div ref={contentEndRef} />
          </div>
        ) : (
          <div className="notesPanel__empty">
            No notes for this day yet. Click the mic button to start recording.
          </div>
        )}
      </div>

      {/* Floating action button */}
      <div className="notesPanel__fab">
        {error && <div className="notesPanel__error">{error}</div>}
        {transcribingCount > 0 && (
          <span className="notesPanel__status">
            <span className="notesPanel__statusDot" />
            Transcribing{transcribingCount > 1 ? ` (${transcribingCount})` : ''}
          </span>
        )}
        {isRecording && (
          <span className="notesPanel__timer">{formatDuration(duration)}</span>
        )}
        <button
          className={`notesPanel__recordBtn ${isRecording ? 'notesPanel__recordBtn--recording' : ''}`}
          onClick={isRecording ? stopRecording : startRecording}
          title={isRecording ? 'Stop recording' : 'Start recording'}
        >
          {isRecording ? (
            <SquareIcon style={{ width: 24, height: 24 }} />
          ) : (
            <MicIcon style={{ width: 24, height: 24 }} />
          )}
        </button>
      </div>
    </div>
  );
}
