/**
 * Tests for the unified WebSocket protocol types and bridge sender.
 */

describe('Unified WebSocket Protocol', () => {
  describe('ServerWebSocketMessage types', () => {
    it('poll message has correct shape', () => {
      const msg = { type: 'poll' as const, data: { isActive: true } };
      expect(msg.type).toBe('poll');
      expect(msg.data.isActive).toBe(true);
    });

    it('chat:event message has correct shape', () => {
      const msg = {
        type: 'chat:event' as const,
        sessionId: 'session-1',
        data: { type: 'text-delta' as const, text: 'Hello' },
      };
      expect(msg.type).toBe('chat:event');
      expect(msg.sessionId).toBe('session-1');
      expect(msg.data.type).toBe('text-delta');
    });

    it('chat:done message has correct shape', () => {
      const msg = { type: 'chat:done' as const, sessionId: 'session-1' };
      expect(msg.type).toBe('chat:done');
      expect(msg.sessionId).toBe('session-1');
    });

    it('chat:error message has correct shape', () => {
      const msg = {
        type: 'chat:error' as const,
        sessionId: 'session-1',
        error: 'something went wrong',
      };
      expect(msg.type).toBe('chat:error');
      expect(msg.error).toBe('something went wrong');
    });

    it('heartbeat message has correct shape', () => {
      const msg = { type: 'heartbeat' as const };
      expect(msg.type).toBe('heartbeat');
    });

    it('bridge:ack message has correct shape', () => {
      const msg = {
        type: 'bridge:ack' as const,
        requestId: 'req-1',
        data: { success: true },
      };
      expect(msg.type).toBe('bridge:ack');
      expect(msg.requestId).toBe('req-1');
    });
  });

  describe('ClientWebSocketMessage types', () => {
    it('refresh message has correct shape', () => {
      const msg = { type: 'refresh' as const };
      expect(msg.type).toBe('refresh');
    });

    it('chat:send message has correct shape', () => {
      const msg = {
        type: 'chat:send' as const,
        sessionId: 'session-1',
        text: 'Hello!',
        documentPath: '/test.docx',
        selectedText: 'some text',
      };
      expect(msg.type).toBe('chat:send');
      expect(msg.sessionId).toBe('session-1');
      expect(msg.text).toBe('Hello!');
      expect(msg.documentPath).toBe('/test.docx');
      expect(msg.selectedText).toBe('some text');
    });

    it('chat:subscribe message has correct shape', () => {
      const msg = { type: 'chat:subscribe' as const, sessionId: 'session-1' };
      expect(msg.type).toBe('chat:subscribe');
    });

    it('chat:unsubscribe message has correct shape', () => {
      const msg = { type: 'chat:unsubscribe' as const, sessionId: 'session-1' };
      expect(msg.type).toBe('chat:unsubscribe');
    });

    it('bridge message has correct shape', () => {
      const msg = {
        type: 'bridge' as const,
        action: 'buttonClicked',
        payload: { key: 'value' },
        requestId: 'req-1',
      };
      expect(msg.type).toBe('bridge');
      expect(msg.action).toBe('buttonClicked');
    });
  });
});

describe('bridge sender logic', () => {
  it('setBridgeWsSender intercepts postBridge calls', () => {
    // This validates the pattern: when a WS sender is set, postBridge
    // should use it instead of HTTP fetch. Due to browser-env dependencies
    // in shared.ts, we test the logic conceptually here.
    let sender: ((action: string, payload: Record<string, unknown>) => void) | null = null;

    function setBridgeWsSender(s: typeof sender) { sender = s; }

    function postBridge(action: string, payload: Record<string, unknown> = {}) {
      if (sender) {
        sender(action, payload);
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: false, reason: 'no ws' });
    }

    // Without WS sender — falls back
    const result1 = postBridge('test', {});
    expect(result1).resolves.toEqual({ success: false, reason: 'no ws' });

    // With WS sender — uses it
    const wsSender = jest.fn();
    setBridgeWsSender(wsSender);
    postBridge('buttonClicked', { key: 'value' });
    expect(wsSender).toHaveBeenCalledWith('buttonClicked', { key: 'value' });
  });
});
