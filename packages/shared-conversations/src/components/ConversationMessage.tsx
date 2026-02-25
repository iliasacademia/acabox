import React from 'react';
import Markdown from 'markdown-to-jsx';
import DOMPurify from 'isomorphic-dompurify';
import { Message, FollowUpQuestion, SearchFilesData, SearchFilesMatchedFile } from '../types/conversation';
import { SearchFilesMessage } from './SearchFilesMessage';

interface ConversationMessageProps {
  message: Message;
  onShowDiff?: () => void;
  onQuestionClick?: (question: string) => void;
  onFactCheckClick?: (reviewId: number) => void;
  onOpenFile?: (file: SearchFilesMatchedFile, page?: string) => void;
  /** True once a search_files_result message has arrived for this search */
  isSearchComplete?: boolean;
  conversationReviewId?: number; // Review ID from conversation.review_id
  showQuestions?: boolean;
  showFactCheck?: boolean; // Whether to show fact-check button
}

export function ConversationMessage({ message, onShowDiff, onQuestionClick, onFactCheckClick, onOpenFile, isSearchComplete, conversationReviewId, showQuestions, showFactCheck }: ConversationMessageProps) {
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

  // Extract questions from message.data and separate by type
  // Check both 'extracted_questions' and 'follow_up_actions' (backend may use either)
  const extractedQuestions = (message.data?.extracted_questions || message.data?.follow_up_actions) as FollowUpQuestion[] | undefined;
  const factCheckQuestion = extractedQuestions?.find(q => q.type === 'fact_check_review');
  const textPromptQuestions = extractedQuestions?.filter(q => q.type === 'text_prompt') || [];

  // Use review_id from conversation only
  const reviewId = conversationReviewId;

  // Get label and description for fact-check button
  const factCheckLabel = factCheckQuestion?.label || 'Fact check and refine';
  const factCheckDescription = factCheckQuestion?.description;

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

      {/* Show fact-check button for review messages (first assistant message) */}
      {showFactCheck && onFactCheckClick && reviewId != null && (
        <div className="factCheckButtonContainer">
          <button
            type="button"
            className="factCheckButton"
            onClick={() => onFactCheckClick(reviewId)}
            title={factCheckDescription}
          >
            {factCheckLabel}
          </button>
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
