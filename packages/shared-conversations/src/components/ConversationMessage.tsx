import React from 'react';
import Markdown from 'markdown-to-jsx';
import DOMPurify from 'isomorphic-dompurify';
import { Message, FollowUpQuestion, SearchFilesData, SearchFilesMatchedFile } from '../types/conversation';
import { SearchFilesMessage } from './SearchFilesMessage';

interface ConversationMessageProps {
  message: Message;
  onShowDiff?: () => void;
  onQuestionClick?: (question: string) => void;
  onOpenFile?: (file: SearchFilesMatchedFile, page?: string) => void;
  /** True once a search_files_result message has arrived for this search */
  isSearchComplete?: boolean;
  showQuestions?: boolean;
  hideContexts?: boolean; // Hide manuscript/file context pills (e.g. for free-form conversations)
}

export function ConversationMessage({ message, onShowDiff, onQuestionClick, onOpenFile, isSearchComplete, showQuestions, hideContexts }: ConversationMessageProps) {
  const isTool = message.role === 'tool';

  // Tool messages are handled by ToolMessageAccordion, skip rendering here
  if (isTool) {
    return null;
  }

  // Search agent: progress messages render as structured file list
  // search_files_result falls through to normal HTML rendering below
  // search_files_error renders an error banner
  const msgType = (message.data as { message_type?: string } | null)?.message_type;

  if (msgType === 'search_files_progress') {
    return (
      <div className="conversationMessage assistant">
        <div className="messageContent">
          <SearchFilesMessage
            data={message.data as unknown as SearchFilesData}
            onOpenFile={onOpenFile}
            isSearchComplete={isSearchComplete}
          />
        </div>
      </div>
    );
  }

  if (msgType === 'search_files_error') {
    return (
      <div className="conversationMessage assistant">
        <div className="messageContent">
          <div className="searchFilesError">
            <span className="searchFilesErrorIcon" aria-hidden="true">⚠</span>
            <span>{message.content || 'Search failed. Please try again.'}</span>
          </div>
        </div>
      </div>
    );
  }

  // Extract questions from message.data
  // Check both 'extracted_questions' and 'follow_up_actions' (backend may use either)
  const extractedQuestions = (message.data?.extracted_questions || message.data?.follow_up_actions) as FollowUpQuestion[] | undefined;
  const textPromptQuestions = extractedQuestions?.filter(q => q.type === 'text_prompt') || [];

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

  // Strip markdown code fences if the LLM accidentally wraps its HTML output (e.g. ```html\n...\n```)
  const htmlContent = message.format === 'html' && message.content
    ? message.content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
    : message.content;

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
                __html: DOMPurify.sanitize(htmlContent, {
                  ALLOWED_TAGS: [
                    'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'ul', 'ol', 'li',
                    'a', 'img',
                    'blockquote',
                    'table', 'thead', 'tbody', 'tr', 'th', 'td',
                    'div', 'span',
                    'sup', 'sub',   // citation superscripts, chemical subscripts
                    'mark',         // highlighted text
                    'abbr',         // abbreviations with title tooltip
                    'hr',           // section dividers
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

      {/* File attachment contexts — always shown on user messages, excluding the primary manuscript */}
      {(() => {
        if (message.role !== 'user' || !message.contexts?.length) return null;
        const fileContexts = message.contexts.filter(c =>
          c.target_type === 'CoScientist::ProjectFile' &&
          !c.project_file?.tags?.some(t => t.tag_type === 'manuscript' && t.tag === 'primary')
        );
        if (!fileContexts.length) return null;
        return (
          <div className="messageContexts">
            {fileContexts.map((context) => (
              <div key={context.id} className="messageFileContext">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>{
                  (context.project_file?.rel_path ?? context.target_name ?? `File #${context.target_id}`)
                    .split('/').pop()
                }</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Other contexts (manuscript etc) — hidden for free-form conversations without a review */}
      {!hideContexts && message.contexts && message.contexts.some(c => c.target_type !== 'CoScientist::ProjectFile') && (
        <div className="messageContexts">
          {message.contexts.filter(c => c.target_type !== 'CoScientist::ProjectFile').map((context) => (
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
      {showQuestions && textPromptQuestions.length > 0 && (
        <div className="questionPills">
          {textPromptQuestions.map((question, index) => (
            <button
              key={index}
              type="button"
              className="questionPill"
              onClick={() => question.text && handleQuestionClick(question.text)}
            >
              {question.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
