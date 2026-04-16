import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquareIcon } from 'lucide-react';
import './NotesAssistantThread.css';

interface MessagePair {
  request: string;
  response: string;
  timestamp: string;
}

export function NotesAssistantThread({ dayFile }: { dayFile: string }) {
  const [messages, setMessages] = useState<MessagePair[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Load existing messages when day changes
  useEffect(() => {
    setMessages([]);
    setError(null);
    window.notesAPI.getAssistantMessages(dayFile).then((dbMessages) => {
      const pairs: MessagePair[] = [];
      // Match user/assistant pairs by type rather than assuming strict alternation
      let i = 0;
      while (i < dbMessages.length) {
        if (dbMessages[i].type !== 'user') { i++; continue; }
        const userMsg = dbMessages[i];
        if (i + 1 < dbMessages.length && dbMessages[i + 1].type === 'assistant') {
          const assistantMsg = dbMessages[i + 1];
          try {
            pairs.push({
              request: JSON.parse(userMsg.content).text,
              response: JSON.parse(assistantMsg.content).text,
              timestamp: userMsg.created_at,
            });
          } catch {
            // Skip malformed messages
          }
          i += 2;
        } else {
          i++;
        }
      }
      setMessages(pairs);
    });
  }, [dayFile]);

  // Subscribe to live assistant messages and errors
  useEffect(() => {
    const cleanupMessage = window.notesAPI.onAssistantMessage((data) => {
      if (data.dayFile === dayFile) {
        setError(null);
        setMessages((prev) => [...prev, {
          request: data.request,
          response: data.response,
          timestamp: new Date().toISOString(),
        }]);
      }
    });

    const cleanupAnalyzing = window.notesAPI.onAssistantAnalyzing((data) => {
      if (data.dayFile === dayFile) {
        setAnalyzing(data.analyzing);
      }
    });

    const cleanupError = window.notesAPI.onAssistantError((data) => {
      if (data.dayFile === dayFile) {
        setError(data.error);
        // Auto-clear after 5 seconds
        setTimeout(() => setError(null), 5000);
      }
    });

    return () => {
      cleanupMessage();
      cleanupAnalyzing();
      cleanupError();
    };
  }, [dayFile]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, analyzing]);

  return (
    <div className="notesAssistantThread">
      <div className="notesAssistantThread__header">
        <MessageSquareIcon style={{ width: 16, height: 16 }} />
        Assistant
      </div>

      {messages.length === 0 && !analyzing ? (
        <div className="notesAssistantThread__empty">
          No assistant interactions yet. When you ask a question while recording, the assistant will respond here.
        </div>
      ) : (
        <div className="notesAssistantThread__messages">
          {messages.map((msg, i) => (
            <div key={i} className="notesAssistantThread__pair">
              <div className="notesAssistantThread__request">
                {msg.request}
              </div>
              <div className="notesAssistantThread__response">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.response}
                </ReactMarkdown>
              </div>
            </div>
          ))}
          {analyzing && (
            <div className="notesAssistantThread__analyzing">
              <span className="notesAssistantThread__analyzingDot" />
              Analyzing transcription...
            </div>
          )}
          {error && (
            <div className="notesAssistantThread__error">
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
