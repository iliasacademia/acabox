/**
 * Tests for the overlay handlers registry.
 */

import {
  setOverlayChatSendHandler,
  getOverlayChatSendHandler,
  setOverlayBridgeHandler,
  getOverlayBridgeHandler,
} from '../overlayHandlers';

describe('overlayHandlers', () => {
  afterEach(() => {
    setOverlayChatSendHandler(null as any);
    setOverlayBridgeHandler(null as any);
  });

  describe('chat send handler', () => {
    it('returns null when no handler is registered', () => {
      expect(getOverlayChatSendHandler()).toBeNull();
    });

    it('stores and retrieves a handler', () => {
      const handler = jest.fn();
      setOverlayChatSendHandler(handler);
      expect(getOverlayChatSendHandler()).toBe(handler);
    });

    it('calls the registered handler with correct params', () => {
      const handler = jest.fn();
      setOverlayChatSendHandler(handler);

      const params = {
        sessionId: 'test-session',
        text: 'Hello',
        documentPath: '/test.docx',
        selectedText: 'some text',
        onEvent: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      };

      getOverlayChatSendHandler()!(params);
      expect(handler).toHaveBeenCalledWith(params);
    });
  });

  describe('bridge handler', () => {
    it('returns null when no handler is registered', () => {
      expect(getOverlayBridgeHandler()).toBeNull();
    });

    it('stores and retrieves a handler', () => {
      const handler = jest.fn();
      setOverlayBridgeHandler(handler);
      expect(getOverlayBridgeHandler()).toBe(handler);
    });

    it('calls the registered handler with correct params', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      setOverlayBridgeHandler(handler);

      const params = {
        action: 'buttonClicked',
        payload: {},
        wid: 'window-1',
      };

      const result = await getOverlayBridgeHandler()!(params);
      expect(handler).toHaveBeenCalledWith(params);
      expect(result).toEqual({ success: true });
    });
  });
});
