import React, { useState } from 'react';
import Markdown from 'markdown-to-jsx';
import { Message } from '../../services/conversationsApi';

interface ToolMessageAccordionProps {
  messages: Message[];
}

interface ToolDisplayInfo {
  isCustomTool: boolean;
  headerText?: string;
  resultContent?: string;
  toolName?: string;
  toolAction?: string;
  hideStepCount: boolean;
  hideParameters: boolean;
}

// Helper to get display info for a tool message
function getToolDisplayInfo(message: Message): ToolDisplayInfo {
  const toolResult = message.data?.tool_result;
  const toolCall = message.data?.tool_call;

  // Special handling for save_user_preference
  if (toolResult?.name === 'save_user_preference') {
    const preference = toolResult.arguments?.preference || '';
    return {
      isCustomTool: true,
      headerText: `Saving User Preference - '${preference}'`,
      resultContent: toolResult.result?.success
        ? 'User Preference Updated!'
        : 'Updating User Preference Failed. Please try again.',
      hideStepCount: true,
      hideParameters: true,
    };
  }

  // Default behavior for other tools
  return {
    isCustomTool: false,
    toolName: toolCall?.name || toolResult?.name || 'Tool',
    toolAction: toolCall?.action || 'Processing',
    hideStepCount: false,
    hideParameters: false,
  };
}

export function ToolMessageAccordion({ messages }: ToolMessageAccordionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (messages.length === 0) return null;

  // Extract tool display info from first message
  const firstMessage = messages[0];
  const toolInfo = getToolDisplayInfo(firstMessage);

  return (
    <div className="toolMessageAccordion">
      <button
        className="accordionHeader"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <span className="accordionIcon">{isExpanded ? '▼' : '▶'}</span>
        <span className="accordionTitle">
          {toolInfo.isCustomTool ? (
            <span className="toolName">{toolInfo.headerText}</span>
          ) : (
            <>
              <span className="toolName">{toolInfo.toolName}</span>
              {toolInfo.toolAction && (
                <span className="toolAction"> — {toolInfo.toolAction}</span>
              )}
            </>
          )}
        </span>
        {!toolInfo.hideStepCount && (
          <span className="toolMessageCount">
            {messages.length} {messages.length === 1 ? 'step' : 'steps'}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="accordionContent">
          {messages.map((message, index) => {
            const messageInfo = getToolDisplayInfo(message);
            return (
              <div key={message.id} className="toolMessage">
                <div className="toolMessageHeader">
                  <span className="toolMessageNumber">Step {index + 1}</span>
                  {!messageInfo.isCustomTool && message.data?.tool_call?.name && (
                    <span className="toolMessageName">
                      {message.data.tool_call.name}
                    </span>
                  )}
                </div>

                <div className="toolMessageContent">
                  {messageInfo.isCustomTool ? (
                    <span>{messageInfo.resultContent}</span>
                  ) : message.content ? (
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
                {!messageInfo.hideParameters && message.data?.tool_call?.parameters && (
                  <details className="toolParameters">
                    <summary>Parameters</summary>
                    <pre className="parametersJson">
                      {JSON.stringify(message.data.tool_call.parameters, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
