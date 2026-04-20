import React, { useState, useEffect, useRef } from 'react';
import './WritingAgentView.css';

interface ConversationMessage {
  id: number;
  role: string;
  content: string;
  format?: string | null;
  created_at: string;
}

interface ConversationDetail {
  conversation: {
    id: number;
    title: string | null;
    summary: string | null;
    agent_name: string;
  };
  messages: ConversationMessage[];
}

/** Detect if content is HTML rather than plain text/markdown */
function looksLikeHtml(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

interface WritingAgentConversationViewProps {
  conversationId: number;
  projectId: number;
}

export const WritingAgentConversationView: React.FC<WritingAgentConversationViewProps> = ({
  conversationId,
  projectId,
}) => {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    window.writingAgentAPI
      .getConversationDetail(conversationId, projectId)
      .then((data: ConversationDetail) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err.message || 'Failed to load conversation');
        setLoading(false);
      });
  }, [conversationId, projectId]);

  useEffect(() => {
    if (detail) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail]);

  if (loading) {
    return (
      <div className="writingAgentView">
        <div className="conversationMessages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="messageLoading">
            <div className="loadingDot" />
            <div className="loadingDot" />
            <div className="loadingDot" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="writingAgentView">
        <div className="conversationMessages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="emptyMessage">{error || 'Conversation not found'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="writingAgentView">
      <div className="conversationHeader">
        <div>
          <h2 className="conversationTitle">
            {detail.conversation.title || 'Untitled conversation'}
          </h2>
          {detail.conversation.summary && (
            <p className="conversationSummary">{detail.conversation.summary}</p>
          )}
        </div>
      </div>
      <div className="conversationMessages">
        {detail.messages
          .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
          .map((msg) => {
            const isHtml = msg.format === 'html' || (msg.role === 'assistant' && looksLikeHtml(msg.content));
            return (
              <div
                key={msg.id}
                className={`conversationMessage ${msg.role}`}
              >
                <div className="messageContent">
                  {isHtml ? (
                    <div
                      className="htmlContent"
                      dangerouslySetInnerHTML={{ __html: msg.content }}
                    />
                  ) : (
                    <MessageMarkdown content={msg.content} />
                  )}
                </div>
              </div>
            );
          })}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

/** Simple markdown-to-JSX renderer for plain text messages */
const MessageMarkdown: React.FC<{ content: string }> = ({ content }) => {
  // Split into paragraphs and render basic markdown
  const paragraphs = content.split('\n\n');

  return (
    <>
      {paragraphs.map((para, i) => {
        // Check for headers
        const h1 = para.match(/^# (.+)$/m);
        if (h1) return <h1 key={i}>{h1[1]}</h1>;
        const h2 = para.match(/^## (.+)$/m);
        if (h2) return <h2 key={i}>{h2[1]}</h2>;
        const h3 = para.match(/^### (.+)$/m);
        if (h3) return <h3 key={i}>{h3[1]}</h3>;

        // Check for code blocks
        const codeMatch = para.match(/^```[\s\S]*?\n([\s\S]*?)```$/m);
        if (codeMatch) {
          return <pre key={i} className="codeBlock">{codeMatch[1]}</pre>;
        }

        // Check for unordered list
        const lines = para.split('\n');
        if (lines.every((l) => l.match(/^[-*] /) || l.trim() === '')) {
          return (
            <ul key={i}>
              {lines
                .filter((l) => l.match(/^[-*] /))
                .map((l, j) => (
                  <li key={j}>{renderInline(l.replace(/^[-*] /, ''))}</li>
                ))}
            </ul>
          );
        }

        // Check for ordered list
        if (lines.every((l) => l.match(/^\d+\. /) || l.trim() === '')) {
          return (
            <ol key={i}>
              {lines
                .filter((l) => l.match(/^\d+\. /))
                .map((l, j) => (
                  <li key={j}>{renderInline(l.replace(/^\d+\. /, ''))}</li>
                ))}
            </ol>
          );
        }

        // Regular paragraph — render with line breaks preserved
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(line)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
};

/** Render inline markdown: bold, italic, inline code */
function renderInline(text: string): React.ReactNode {
  // Split on inline code, bold, italic patterns
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(codeMatch[1]);
      parts.push(<code key={key++} className="inlineCode">{codeMatch[2]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(boldMatch[1]);
      parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    // Italic
    const italicMatch = remaining.match(/^(.*?)(?<!\*)\*([^*]+)\*(?!\*)/);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(italicMatch[1]);
      parts.push(<em key={key++}>{italicMatch[2]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }
    // No more patterns
    parts.push(remaining);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
