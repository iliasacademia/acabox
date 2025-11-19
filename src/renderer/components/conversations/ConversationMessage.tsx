import React from 'react';
import Markdown from 'markdown-to-jsx';
import { Message } from '../../services/conversationsApi';

interface ConversationMessageProps {
  message: Message;
}

export function ConversationMessage({ message }: ConversationMessageProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isTool = message.role === 'tool';

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  // Tool messages are handled by ToolMessageAccordion, skip rendering here
  if (isTool) {
    return null;
  }

  return (
    <div className={`conversationMessage ${message.role}`}>
      <div className="messageContent">
        {message.content ? (
          <Markdown
            options={{
              overrides: {
                // Style code blocks
                code: {
                  component: ({ children, className }) => {
                    const isBlock = className?.includes('lang-');
                    if (isBlock) {
                      return (
                        <pre className="codeBlock">
                          <code className={className}>{children}</code>
                        </pre>
                      );
                    }
                    return <code className="inlineCode">{children}</code>;
                  },
                },
                // Style links
                a: {
                  component: ({ children, href }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="messageLink"
                    >
                      {children}
                    </a>
                  ),
                },
              },
            }}
          >
            {message.content}
          </Markdown>
        ) : (
          <div className="emptyMessage">
            <em>Thinking...</em>
          </div>
        )}
      </div>

      {/* Show contexts if any */}
      {message.contexts && message.contexts.length > 0 && (
        <div className="messageContexts">
          {message.contexts.map((context) => (
            <div key={context.id} className="messageContext">
              <span className="contextIcon">📎</span>
              <span className="contextName">
                {context.target_name || `${context.target_type} #${context.target_id}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Show loading indicator for incomplete assistant messages */}
      {isAssistant && message.data?.final !== true && (
        <div className="messageLoading">
          <span className="loadingDot"></span>
          <span className="loadingDot"></span>
          <span className="loadingDot"></span>
        </div>
      )}
    </div>
  );
}
