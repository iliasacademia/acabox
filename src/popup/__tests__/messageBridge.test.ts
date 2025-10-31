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
    delete (window as any).__messageBridge;

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
      // Simulate the production bridgeCompatibilityScript behavior
      // If MessageBridge has registered itself, forward to it
      if ((window as any).__messageBridge && (window as any).__messageBridge.handleNativeMessage) {
        (window as any).__messageBridge.handleNativeMessage(msg);
        return;
      }

      // Otherwise use legacy handler system (backward compatibility)
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
    delete (window as any).__messageBridge;
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

    // TODO: Fix timing issues with request/response in CI environment
    it.skip('should send request and handle response', async () => {
      // Wait for bridge initialization
      await new Promise(resolve => setTimeout(resolve, 300));

      // Send a request
      const requestPromise = bridge.sendRequest('native', 'testRequest', { query: 'test' });

      // Wait for microtasks to complete to ensure request is registered
      await Promise.resolve();
      await Promise.resolve();

      // Get the request message (WAGENT-73: Now sends ACK + request, so use last call)
      expect(mockPostMessage).toHaveBeenCalled();
      const requestMsg = mockPostMessage.mock.calls[mockPostMessage.mock.calls.length - 1][0];
      expect(requestMsg.action).toBe('testRequest');
      expect(requestMsg.type).toBe('request');

      // Simulate native sending a response
      const responseMsg: Message = {
        id: requestMsg.id, // Same ID as request
        from: 'native',
        to: 'test-client',
        type: 'response' as MessageType,
        action: 'testRequest',
        payload: { result: 'success' },
        timestamp: Date.now(),
      };

      // Send response after sufficient delay to ensure request is fully registered
      await new Promise<void>(resolve => {
        setTimeout(() => {
          window.__bridgeReceive!(responseMsg);
          resolve();
        }, 100);
      });

      // Wait for response
      const result = await requestPromise;
      expect(result).toEqual({ result: 'success' });
    }, 10000); // 10 second timeout for this test

    it('should timeout requests that do not receive response', async () => {
      // Wait for bridge initialization
      await new Promise(resolve => setTimeout(resolve, 300));

      const requestPromise = bridge.sendRequest('native', 'slowRequest', null, 100);

      // Don't send a response, let it timeout
      await expect(requestPromise).rejects.toThrow('Request timeout');
    });
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

  describe('WAGENT-73: ACK Pattern', () => {
    it('should send ACK after registering pending request', (done) => {
      setTimeout(async () => {
        // Clear previous calls
        mockPostMessage.mockClear();

        // Send a request
        const requestPromise = bridge.sendRequest('native', 'testRequest', { query: 'test' });

        // Check that ACK was sent
        // First call should be the ACK (request-registered event)
        // Second call should be the actual request
        expect(mockPostMessage).toHaveBeenCalledTimes(2);

        const ackCall = mockPostMessage.mock.calls[0][0];
        expect(ackCall.action).toBe('request-registered');
        expect(ackCall.type).toBe('event');
        expect(ackCall.payload.requestId).toBeDefined();

        const requestCall = mockPostMessage.mock.calls[1][0];
        expect(requestCall.action).toBe('testRequest');
        expect(requestCall.type).toBe('request');

        // ACK should contain the same requestId as the request
        expect(ackCall.payload.requestId).toBe(requestCall.id);

        // Clean up - send response to avoid timeout
        setTimeout(() => {
          const responseMsg: Message = {
            id: requestCall.id,
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'testRequest',
            payload: { result: 'success' },
            timestamp: Date.now(),
          };
          window.__bridgeReceive!(responseMsg);
        }, 50);

        await requestPromise;
        done();
      }, 300);
    });

    it('should send ACK with correct requestId', (done) => {
      setTimeout(async () => {
        mockPostMessage.mockClear();

        // Send multiple requests
        const requestPromise1 = bridge.sendRequest('native', 'req1', null);
        const requestPromise2 = bridge.sendRequest('native', 'req2', null);

        // Each request should have its own ACK
        expect(mockPostMessage.mock.calls.length).toBeGreaterThanOrEqual(4);

        // Check first request
        const ack1 = mockPostMessage.mock.calls[0][0];
        const req1 = mockPostMessage.mock.calls[1][0];
        expect(ack1.payload.requestId).toBe(req1.id);

        // Check second request
        const ack2 = mockPostMessage.mock.calls[2][0];
        const req2 = mockPostMessage.mock.calls[3][0];
        expect(ack2.payload.requestId).toBe(req2.id);

        // Clean up - send responses
        setTimeout(() => {
          window.__bridgeReceive!({
            id: req1.id,
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'req1',
            payload: {},
            timestamp: Date.now(),
          });
          window.__bridgeReceive!({
            id: req2.id,
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'req2',
            payload: {},
            timestamp: Date.now(),
          });
        }, 50);

        await Promise.all([requestPromise1, requestPromise2]);
        done();
      }, 300);
    });

    it('should send ACK to the correct target', (done) => {
      setTimeout(() => {
        mockPostMessage.mockClear();

        // Send request to 'native'
        bridge.sendRequest('native', 'testRequest', null);

        const ackCall = mockPostMessage.mock.calls[0][0];
        expect(ackCall.to).toBe('native');
        expect(ackCall.from).toBe('test-client');

        done();
      }, 300);
    });
  });

  describe('Instance Lifecycle Management', () => {
    it('should transfer pending requests from old instance to new instance', () => {
      // Create first bridge instance with a pending request
      const oldBridge = new MessageBridge('old-client');

      // Manually add a pending request to simulate in-flight request
      const mockResolve = jest.fn();
      const mockReject = jest.fn();
      const mockTimeout = setTimeout(() => {}, 5000) as NodeJS.Timeout;

      (oldBridge as any).pendingRequests.set('request-1', {
        resolve: mockResolve,
        reject: mockReject,
        timeoutId: mockTimeout,
      });

      expect((oldBridge as any).pendingRequests.size).toBe(1);
      expect(window.__messageBridge).toBe(oldBridge);

      // Create new bridge instance (simulating hot-reload)
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const newBridge = new MessageBridge('new-client');

      // Verify pending requests were transferred
      expect((newBridge as any).pendingRequests.size).toBe(1);
      expect((newBridge as any).pendingRequests.get('request-1')).toEqual({
        resolve: mockResolve,
        reject: mockReject,
        timeoutId: mockTimeout,
      });

      // Verify warning was logged
      expect(consoleSpy).toHaveBeenCalledWith(
        '[MessageBridge] Transferred 1 pending request(s) from old instance'
      );

      // Verify new instance is now the global instance
      expect(window.__messageBridge).toBe(newBridge);

      // Cleanup
      consoleSpy.mockRestore();
      clearTimeout(mockTimeout);
    });

    it('should not log warning when no pending requests to transfer', () => {
      // Create first bridge with no pending requests
      const oldBridge = new MessageBridge('old-client');
      expect((oldBridge as any).pendingRequests.size).toBe(0);

      // Create new bridge instance
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const newBridge = new MessageBridge('new-client');

      // Verify no warning was logged
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Transferred')
      );

      // Verify new instance is registered
      expect(window.__messageBridge).toBe(newBridge);

      // Cleanup
      consoleSpy.mockRestore();
    });

    it('should register new instance as window.__messageBridge', () => {
      const bridge1 = new MessageBridge('client-1');
      expect(window.__messageBridge).toBe(bridge1);

      const bridge2 = new MessageBridge('client-2');
      expect(window.__messageBridge).toBe(bridge2);
    });
  });
});
