import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MicIcon, SquareIcon } from 'lucide-react';
import './NotesPanel.css';

const CHUNK_SAMPLES = 512;
const SAMPLE_RATE = 16000;
const SCRIPT_BUFFER_SIZE = 4096;

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function encodePcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function NotesPanel({ selectedDay }: { selectedDay: string | null }) {
  const day = selectedDay ?? todayDateString();

  const [noteContent, setNoteContent] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcribingCount, setTranscribingCount] = useState(0);
  const [speechActive, setSpeechActive] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sampleBufRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);
  const dayRef = useRef(day);
  useEffect(() => { dayRef.current = day; }, [day]);

  // Load note content when day changes
  useEffect(() => {
    window.notesAPI.readDay(day).then(setNoteContent);
  }, [day]);

  // Subscribe to transcription and transcribing-state events
  useEffect(() => {
    const cleanupTranscription = window.notesAPI.onTranscription((data) => {
      if (data.dayFile === day) {
        window.notesAPI.readDay(day).then(setNoteContent);
      }
    });

    const cleanupError = window.notesAPI.onTranscriptionError((errMsg) => {
      setError(errMsg);
    });

    const cleanupTranscribing = window.notesAPI.onTranscribingChange((active) => {
      setTranscribingCount((c) => Math.max(0, active ? c + 1 : c - 1));
    });

    const cleanupSpeech = window.notesAPI.onSpeechDetected(setSpeechActive);

    return () => {
      cleanupTranscription();
      cleanupError();
      cleanupTranscribing();
      cleanupSpeech();
    };
  }, [day]);

  // Auto-scroll when content updates
  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [noteContent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      stopAudio();
    };
  }, []);

  function stopAudio() {
    processorRef.current?.disconnect();
    processorRef.current = null;
    sampleBufRef.current = [];
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  const startRecording = useCallback(async () => {
    setError(null);
    setDuration(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);

      // ScriptProcessorNode is deprecated for browsers but stable in Electron —
      // AudioWorkletNode requires blob: URLs which are blocked by our CSP.
      const processor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1); // eslint-disable-line deprecation/deprecation
      processorRef.current = processor;
      sampleBufRef.current = [];

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const buf = sampleBufRef.current;
        for (let i = 0; i < input.length; i++) buf.push(input[i]);
        while (buf.length >= CHUNK_SAMPLES) {
          const chunk = new Float32Array(buf.splice(0, CHUNK_SAMPLES));
          window.notesAPI.sendAudioChunk(encodePcmBase64(chunk), dayRef.current);
        }
      };

      // Must route through destination for onaudioprocess to fire; use gain=0 to silence playback
      const silence = ctx.createGain();
      silence.gain.value = 0;
      source.connect(processor);
      processor.connect(silence);
      silence.connect(ctx.destination);

      setIsRecording(true);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not start recording';
      setError(
        msg.toLowerCase().includes('notallowed') || msg.toLowerCase().includes('permission')
          ? 'Microphone access denied. Please allow microphone access in System Settings > Privacy & Security > Microphone.'
          : msg,
      );
    }
  }, []);

  const stopRecording = useCallback(() => {
    window.notesAPI.stopRecording();
    stopAudio();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
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

      <div className="notesPanel__fab">
        {error && <div className="notesPanel__error">{error}</div>}
        {speechActive && (
          <span className="notesPanel__status">
            <span className="notesPanel__statusDot notesPanel__statusDot--voice" />
            Voice detected
          </span>
        )}
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
