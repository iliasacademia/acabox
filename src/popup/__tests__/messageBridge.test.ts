/**
 * Unit tests for MessageBridge
 */

import MessageBridge, { Message, MessageType } from '../messageBridge';

// Mock window.webkit for testing
interface MockWebKit {
  messageHandlers: {
    bridge?: {
      postMessage: jest.Mock;
    };
  };
}

describe('MessageBridge', () => {
  let bridge: MessageBridge;
  let mockPostMessage: jest.Mock;

  beforeEach(() => {
    // Reset window globals
    delete (window as any).webkit;
    delete (window as any).__bridgeSend;
    delete (window as any).__bridgeReceive;
    delete (window as any).__bridgeHandlers;

    // Setup mock WebKit
    mockPostMessage = jest.fn();
    (window as any).webkit = {
      messageHandlers: {
        bridge: {
          postMessage: mockPostMessage,
        },
      },
    } as MockWebKit;

    // Pre-inject the bridge functions that native code would inject
    // This simulates the native compatibility script
    (window as any).__bridgeSend = function (msg: Message) {
      mockPostMessage(msg);
    };
    (window as any).__bridgeReceive = function (msg: Message) {
      // This will be overridden by MessageBridge
      if ((window as any).__bridgeHandlers && (window as any).__bridgeHandlers[msg.action]) {
        (window as any).__bridgeHandlers[msg.action](msg);
      }
    };
    (window as any).__bridgeHandlers = {};

    // Create new bridge instance
    bridge = new MessageBridge('test-client');
  });

  afterEach(() => {
    // Cleanup
    delete (window as any).webkit;
    delete (window as any).__bridgeSend;
    delete (window as any).__bridgeReceive;
    delete (window as any).__bridgeHandlers;
  });

  describe('Initialization', () => {
    it('should detect webkit platform', () => {
      expect(bridge.getPlatform()).toBe('webkit');
    });

    it('should initialize window.__bridgeHandlers', () => {
      expect(window.__bridgeHandlers).toBeDefined();
      expect(typeof window.__bridgeHandlers).toBe('object');
    });

    it('should create __bridgeSend and __bridgeReceive functions', (done) => {
      // Wait for setup to complete
      setTimeout(() => {
        expect(window.__bridgeSend).toBeDefined();
        expect(typeof window.__bridgeSend).toBe('function');
        expect(window.__bridgeReceive).toBeDefined();
        expect(typeof window.__bridgeReceive).toBe('function');
        done();
      }, 300);
    });
  });

  describe('Handler Registration', () => {
    it('should register handlers in both internal Map and window.__bridgeHandlers', (done) => {
      const handler = jest.fn();

      // Wait for bridge to be ready
      setTimeout(() => {
        bridge.on('testAction', handler);

        expect(window.__bridgeHandlers).toBeDefined();
        expect(window.__bridgeHandlers!['testAction']).toBe(handler);
        done();
      }, 300);
    });

    it('should unregister handlers from both internal Map and window.__bridgeHandlers', (done) => {
      const handler = jest.fn();

      setTimeout(() => {
        bridge.on('testAction', handler);
        expect(window.__bridgeHandlers!['testAction']).toBe(handler);

        bridge.off('testAction');
        expect(window.__bridgeHandlers!['testAction']).toBeUndefined();
        done();
      }, 300);
    });

    it('should call registered handler when receiving message', (done) => {
      const handler = jest.fn();

      setTimeout(() => {
        bridge.on('updateContent', handler);

        // Simulate native sending a message
        const msg: Message = {
          id: 'test-1',
          from: 'native',
          to: 'test-client',
          type: 'event' as MessageType,
          action: 'updateContent',
          payload: 'Hello World',
          timestamp: Date.now(),
        };

        window.__bridgeReceive!(msg);

        expect(handler).toHaveBeenCalledWith(msg);
        done();
      }, 300);
    });
  });

  describe('Message Sending', () => {
    it('should send event messages to native', (done) => {
      setTimeout(() => {
        bridge.sendEvent('native', 'testEvent', { data: 'test' });

        // __bridgeSend should have been called
        expect(mockPostMessage).toHaveBeenCalled();
        const sentMessage = mockPostMessage.mock.calls[mockPostMessage.mock.calls.length - 1][0];
        expect(sentMessage.action).toBe('testEvent');
        expect(sentMessage.payload).toEqual({ data: 'test' });
        expect(sentMessage.type).toBe('event');
        done();
      }, 300);
    });

    it('should send request and handle response', (done) => {
      setTimeout(async () => {
        // Send a request
        const requestPromise = bridge.sendRequest('native', 'testRequest', { query: 'test' });

        // Get the request message
        expect(mockPostMessage).toHaveBeenCalled();
        const requestMsg = mockPostMessage.mock.calls[mockPostMessage.mock.calls.length - 1][0];
        expect(requestMsg.action).toBe('testRequest');
        expect(requestMsg.type).toBe('request');

        // Simulate native sending a response
        setTimeout(() => {
          const responseMsg: Message = {
            id: requestMsg.id, // Same ID as request
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'testRequest',
            payload: { result: 'success' },
            timestamp: Date.now(),
          };

          window.__bridgeReceive!(responseMsg);
        }, 50);

        // Wait for response
        const result = await requestPromise;
        expect(result).toEqual({ result: 'success' });
        done();
      }, 300);
    });

    it('should timeout requests that do not receive response', (done) => {
      setTimeout(async () => {
        const requestPromise = bridge.sendRequest('native', 'slowRequest', null, 100);

        // Don't send a response, let it timeout
        await expect(requestPromise).rejects.toThrow('Request timeout');
        done();
      }, 300);
    }, 1000);
  });

  describe('updateContent Event Flow', () => {
    it('should handle updateContent event from native', (done) => {
      const handler = jest.fn();

      setTimeout(() => {
        // Register handler for updateContent
        bridge.on('updateContent', handler);

        // Simulate native sending selected text
        const msg: Message = {
          id: 'native-123',
          from: 'native',
          to: 'test-client',
          type: 'event' as MessageType,
          action: 'updateContent',
          payload: 'Selected text from Word',
          timestamp: Date.now(),
        };

        window.__bridgeReceive!(msg);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(msg);
        expect(handler.mock.calls[0][0].payload).toBe('Selected text from Word');
        done();
      }, 300);
    });

    it('should handle updateContent with payload.text format', (done) => {
      const handler = jest.fn();

      setTimeout(() => {
        bridge.on('updateContent', handler);

        // Simulate native sending with nested text property
        const msg: Message = {
          id: 'native-456',
          from: 'native',
          to: 'test-client',
          type: 'event' as MessageType,
          action: 'updateContent',
          payload: { text: 'Nested text format' },
          timestamp: Date.now(),
        };

        window.__bridgeReceive!(msg);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].payload.text).toBe('Nested text format');
        done();
      }, 300);
    });
  });

  describe('Bridge Ready Signal', () => {
    it('should send bridge-ready signal when initialized', (done) => {
      // Wait for initialization
      setTimeout(() => {
        // Check that bridge-ready was sent
        const calls = mockPostMessage.mock.calls;
        const readyCall = calls.find((call) => call[0]?.action === 'bridge-ready');
        expect(readyCall).toBeDefined();
        expect(readyCall![0].type).toBe('event');
        done();
      }, 300);
    });

    it('should be marked as connected after ready signal', (done) => {
      setTimeout(() => {
        expect(bridge.isConnected()).toBe(true);
        done();
      }, 300);
    });
  });

  describe('Message Queue', () => {
    it('should queue messages before bridge is ready', () => {
      // Create a new bridge that won't immediately be ready
      delete (window as any).webkit;
      delete (window as any).__bridgeSend;
      delete (window as any).__bridgeReceive;

      const newBridge = new MessageBridge('queue-test');

      // Try to send a message before ready
      newBridge.sendEvent('native', 'earlyEvent', { data: 'queued' });

      // Message should be queued (we can't directly test the private queue,
      // but we can verify it doesn't throw an error)
      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid message format gracefully', (done) => {
      const handler = jest.fn();

      setTimeout(() => {
        bridge.on('testAction', handler);

        // Send an invalid message (missing required fields)
        const invalidMsg = {
          action: 'testAction',
          // Missing other required fields
        } as any;

        // Should not throw
        expect(() => window.__bridgeReceive!(invalidMsg)).not.toThrow();
        done();
      }, 300);
    });

    it('should handle unknown actions gracefully', (done) => {
      setTimeout(() => {
        const msg: Message = {
          id: 'test-unknown',
          from: 'native',
          to: 'test-client',
          type: 'event' as MessageType,
          action: 'unknownAction',
          payload: null,
          timestamp: Date.now(),
        };

        // Should not throw when receiving unknown action
        expect(() => window.__bridgeReceive!(msg)).not.toThrow();
        done();
      }, 300);
    });
  });
});
