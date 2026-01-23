import React from 'react';
import Markdown from 'markdown-to-jsx';
import DOMPurify from 'isomorphic-dompurify';
import { Message } from '../types/conversation';

interface ConversationMessageProps {
  message: Message;
  onShowDiff?: () => void;
  onQuestionClick?: (question: string) => void;
  showQuestions?: boolean;
}

export function ConversationMessage({ message, onShowDiff, onQuestionClick, showQuestions }: ConversationMessageProps) {
  const isAssistant = message.role === 'assistant';
  const isTool = message.role === 'tool';

  // Tool messages are handled by ToolMessageAccordion, skip rendering here
  if (isTool) {
    return null;
  }

  // Extract questions from message.data if present (array of strings)
  const extractedQuestions = message.data?.extracted_questions as string[] | undefined;

  // Handle clicks on links in HTML content
  const handleHtmlClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'A') {
      const href = target.getAttribute('href');
      if (href === '#show-diff' && onShowDiff) {
        e.preventDefault();
        onShowDiff();
      }
    }
  };

  // Handle question pill click
  const handleQuestionClick = (question: string) => {
    if (onQuestionClick) {
      onQuestionClick(question);
    }
  };

  return (
    <div className={`conversationMessage ${message.role}`}>
      <div className="messageContent">
        {message.content ? (
          message.format === 'html' ? (
            // Render as sanitized HTML
            <div
              className="htmlContent"
              onClick={handleHtmlClick}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(message.content, {
                  ALLOWED_TAGS: [
                    'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'ul', 'ol', 'li',
                    'a', 'img',
                    'blockquote',
                    'table', 'thead', 'tbody', 'tr', 'th', 'td',
                    'div', 'span',
                  ],
                  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel'],
                  ALLOW_DATA_ATTR: false,
                }),
              }}
            />
          ) : (
            // Render as Markdown (default)
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
                    component: ({ children, href }) => {
                      // Check if this is a diff link
                      if (href === '#show-diff' && onShowDiff) {
                        return (
                          <button
                            type="button"
                            onClick={onShowDiff}
                            className="messageLinkButton"
                          >
                            {children}
                          </button>
                        );
                      }
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="messageLink"
                        >
                          {children}
                        </a>
                      );
                    },
                  },
                },
              }}
            >
              {message.content}
            </Markdown>
          )
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

      {/* Show question pills only when showQuestions is true */}
      {showQuestions && extractedQuestions && extractedQuestions.length > 0 && (
        <div className="questionPills">
          {extractedQuestions.map((question, index) => (
            <button
              key={question + index}
              type="button"
              className="questionPill"
              onClick={() => handleQuestionClick(question)}
            >
              {question}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
