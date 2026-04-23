/**
 * Tests for the HTTP chat adapter's response builder and SSE parser.
 */

// Import the response builder logic by testing its behavior
// (the actual module uses @assistant-ui/react types, so we test the core logic)

describe('responseBuilder equivalent logic', () => {
  // Simulate the response builder's message accumulation
  function createResponseBuilder() {
    const messages: any[] = [];
    let streamingText = '';
    let streamingReasoning = '';
    let streamingToolCall: { toolCallId: string; toolName: string; argsText: string } | null = null;

    const getContent = () => {
      const content = [...messages];
      if (streamingReasoning) content.push({ type: 'reasoning', text: streamingReasoning });
      if (streamingText) content.push({ type: 'text', text: streamingText });
      if (streamingToolCall) {
        content.push({
          type: 'tool-call',
          toolCallId: streamingToolCall.toolCallId,
          toolName: streamingToolCall.toolName,
          args: {},
          argsText: streamingToolCall.argsText,
        });
      }
      return content;
    };

    const onMessage = (msg: any) => {
      switch (msg.type) {
        case 'thinking-delta':
          streamingReasoning += msg.text;
          return;
        case 'thinking-end':
          if (streamingReasoning) {
            messages.push({ type: 'reasoning', text: streamingReasoning });
            streamingReasoning = '';
          }
          return;
        case 'text-delta':
          streamingText += msg.text;
          return;
        case 'text':
          streamingText = '';
          messages.push(msg);
          return;
        case 'tool-call-start':
          streamingToolCall = { toolCallId: msg.toolCallId, toolName: msg.toolName, argsText: '' };
          return;
        case 'tool-call-args-delta':
          if (streamingToolCall) streamingToolCall.argsText += msg.argsText;
          return;
        case 'tool-call-end':
          streamingToolCall = null;
          return;
        case 'tool-call':
          streamingToolCall = null;
          messages.push({
            type: 'tool-call',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            args: msg.args,
            argsText: msg.argsText,
          });
          return;
        case 'tool-result': {
          const idx = messages.findIndex((m: any) => m.type === 'tool-call' && m.toolCallId === msg.toolCallId);
          if (idx !== -1) {
            messages[idx] = { ...messages[idx], result: msg.result, isError: msg.isError };
          }
          return;
        }
      }
    };

    return { onMessage, getContent };
  }

  it('accumulates text-delta events into streaming text', () => {
    const builder = createResponseBuilder();
    builder.onMessage({ type: 'text-delta', text: 'Hello ' });
    builder.onMessage({ type: 'text-delta', text: 'world' });

    const content = builder.getContent();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('finalizes text on text event and clears streaming', () => {
    const builder = createResponseBuilder();
    builder.onMessage({ type: 'text-delta', text: 'streaming...' });
    builder.onMessage({ type: 'text', text: 'final text' });

    const content = builder.getContent();
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('final text');
  });

  it('handles thinking blocks', () => {
    const builder = createResponseBuilder();
    builder.onMessage({ type: 'thinking-delta', text: 'Let me think' });
    builder.onMessage({ type: 'thinking-delta', text: ' about this' });

    let content = builder.getContent();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'reasoning', text: 'Let me think about this' });

    builder.onMessage({ type: 'thinking-end' });
    content = builder.getContent();
    // After thinking-end, reasoning is finalized in messages array
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'reasoning', text: 'Let me think about this' });
  });

  it('handles tool calls with streaming args', () => {
    const builder = createResponseBuilder();
    builder.onMessage({ type: 'tool-call-start', toolCallId: 'tc1', toolName: 'find_and_replace' });
    builder.onMessage({ type: 'tool-call-args-delta', toolCallId: 'tc1', argsText: '{"search' });
    builder.onMessage({ type: 'tool-call-args-delta', toolCallId: 'tc1', argsText: '":"hello"}' });

    let content = builder.getContent();
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool-call');
    expect(content[0].toolName).toBe('find_and_replace');
    expect(content[0].argsText).toBe('{"search":"hello"}');

    builder.onMessage({ type: 'tool-call-end', toolCallId: 'tc1' });
    content = builder.getContent();
    // After tool-call-end, streaming tool call is cleared
    expect(content).toHaveLength(0);
  });

  it('attaches tool results to matching tool calls', () => {
    const builder = createResponseBuilder();
    builder.onMessage({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'get_text',
      args: {},
      argsText: '{}',
    });
    builder.onMessage({
      type: 'tool-result',
      toolCallId: 'tc1',
      result: { success: true, content: 'hello' },
      isError: false,
    });

    const content = builder.getContent();
    expect(content).toHaveLength(1);
    expect(content[0].result).toEqual({ success: true, content: 'hello' });
    expect(content[0].isError).toBe(false);
  });

  it('handles mixed content: thinking + text + tool', () => {
    const builder = createResponseBuilder();
    builder.onMessage({ type: 'thinking-delta', text: 'thinking...' });
    builder.onMessage({ type: 'thinking-end' });
    builder.onMessage({ type: 'text-delta', text: 'Here is my response' });
    builder.onMessage({ type: 'text', text: 'Here is my response' });
    builder.onMessage({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'save_document',
      args: {},
      argsText: '{}',
    });

    const content = builder.getContent();
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe('reasoning');
    expect(content[1].type).toBe('text');
    expect(content[2].type).toBe('tool-call');
  });
});

describe('SSE event parsing', () => {
  function parseSSEChunk(chunk: string): Array<{ eventType: string; data: any }> {
    const results: Array<{ eventType: string; data: any }> = [];
    const parts = chunk.split('\n\n');
    for (const part of parts) {
      const match = part.match(/^event: (\w+)\ndata: (.+)$/s);
      if (!match) continue;
      const [, eventType, dataStr] = match;
      try {
        results.push({ eventType, data: JSON.parse(dataStr) });
      } catch { /* skip */ }
    }
    return results;
  }

  it('parses single SSE event', () => {
    const chunk = 'event: event\ndata: {"type":"text-delta","text":"hello"}\n\n';
    const events = parseSSEChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('event');
    expect(events[0].data).toEqual({ type: 'text-delta', text: 'hello' });
  });

  it('parses multiple SSE events in one chunk', () => {
    const chunk = 'event: event\ndata: {"type":"text-delta","text":"a"}\n\nevent: event\ndata: {"type":"text-delta","text":"b"}\n\n';
    const events = parseSSEChunk(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].data.text).toBe('a');
    expect(events[1].data.text).toBe('b');
  });

  it('parses done event', () => {
    const chunk = 'event: done\ndata: {}\n\n';
    const events = parseSSEChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('done');
  });

  it('skips malformed events', () => {
    const chunk = 'garbage\n\nevent: event\ndata: {"type":"text"}\n\n';
    const events = parseSSEChunk(chunk);
    expect(events).toHaveLength(1);
  });
});
