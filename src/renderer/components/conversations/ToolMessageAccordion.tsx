import React, { useState } from 'react';
import Markdown from 'markdown-to-jsx';
import { Message } from '../../services/conversationsApi';

interface ToolMessageAccordionProps {
  messages: Message[];
}

export function ToolMessageAccordion({ messages }: ToolMessageAccordionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (messages.length === 0) return null;

  // Extract tool call info from first message
  const firstMessage = messages[0];
  const toolCallData = firstMessage.data?.tool_call;
  const toolName = toolCallData?.name || 'Tool';
  const toolAction = toolCallData?.action || 'Processing';

  return (
    <div className="toolMessageAccordion">
      <button
        className="accordionHeader"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <span className="accordionIcon">{isExpanded ? '▼' : '▶'}</span>
        <span className="accordionTitle">
          <span className="toolName">{toolName}</span>
          {toolAction && (
            <span className="toolAction"> — {toolAction}</span>
          )}
        </span>
        <span className="toolMessageCount">
          {messages.length} {messages.length === 1 ? 'step' : 'steps'}
        </span>
      </button>

      {isExpanded && (
        <div className="accordionContent">
          {messages.map((message, index) => (
            <div key={message.id} className="toolMessage">
              <div className="toolMessageHeader">
                <span className="toolMessageNumber">Step {index + 1}</span>
                {message.data?.tool_call?.name && (
                  <span className="toolMessageName">
                    {message.data.tool_call.name}
                  </span>
                )}
              </div>

              <div className="toolMessageContent">
                {message.content ? (
                  <Markdown
                    options={{
                      overrides: {
                        code: {
                          component: ({ children, className }) => {
                            const isBlock = className?.includes('lang-');
                            if (isBlock) {
                              return (
                                <pre className="toolCodeBlock">
                                  <code className={className}>{children}</code>
                                </pre>
                              );
                            }
                            return <code className="toolInlineCode">{children}</code>;
                          },
                        },
                      },
                    }}
                  >
                    {message.content}
                  </Markdown>
                ) : (
                  <em>No output</em>
                )}
              </div>

              {/* Show tool call parameters if available */}
              {message.data?.tool_call?.parameters && (
                <details className="toolParameters">
                  <summary>Parameters</summary>
                  <pre className="parametersJson">
                    {JSON.stringify(message.data.tool_call.parameters, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
