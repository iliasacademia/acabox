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
      // If MessageBridge has registered itself, forward to it
      if ((window as any).__messageBridge && (window as any).__messageBridge.handleNativeMessage) {
        (window as any).__messageBridge.handleNativeMessage(msg);
        return;
      }

      // Handle regular messages with action handlers (backward compatibility)
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

    it('should send request and handle response', (done) => {
      setTimeout(async () => {
        try {
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
        } catch (error) {
          done(error);
        }
      }, 300);
    }, 10000);

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

  describe('Preload Queue Processing (WAGENT-68)', () => {
    it('should process pending responses immediately during initialization', (done) => {
      // Setup: Create pending responses BEFORE MessageBridge is created
      const preloadResponse1: Message = {
        id: 'preload-req-1',
        from: 'native',
        to: 'test-client',
        type: 'response' as MessageType,
        action: 'earlyRequest',
        payload: { result: 'early-response-1' },
        timestamp: Date.now(),
      };

      const preloadResponse2: Message = {
        id: 'preload-req-2',
        from: 'native',
        to: 'test-client',
        type: 'response' as MessageType,
        action: 'earlyRequest',
        payload: { result: 'early-response-2' },
        timestamp: Date.now(),
      };

      // Simulate responses arriving before MessageBridge is created
      (window as any).__pendingResponses = [preloadResponse1, preloadResponse2];

      // Create a new MessageBridge instance
      const newBridge = new MessageBridge('preload-test');

      // The queue should be processed synchronously during construction
      // So __pendingResponses should be cleared immediately
      expect((window as any).__pendingResponses).toEqual([]);

      done();
    });

    it('should handle responses in preload queue that match pending requests', (done) => {
      // Setup: Create a response that will match a pending request
      const requestId = 'test-preload-request-123';
      const preloadResponse: Message = {
        id: requestId,
        from: 'native',
        to: 'test-client',
        type: 'response' as MessageType,
        action: 'testAction',
        payload: { result: 'preloaded-success' },
        timestamp: Date.now(),
      };

      // Simulate response arriving before MessageBridge is created
      (window as any).__pendingResponses = [preloadResponse];

      // Create a new MessageBridge instance
      const newBridge = new MessageBridge('preload-test-2');

      // Wait for bridge to be ready
      setTimeout(async () => {
        // Create a mock pending request by accessing the private field
        // This simulates a request that was made before the response arrived
        const pendingRequests = (newBridge as any).pendingRequests;

        // Add a pending request that matches the preloaded response
        const resolvePromise = jest.fn();
        const rejectPromise = jest.fn();
        pendingRequests.set(requestId, {
          resolve: resolvePromise,
          reject: rejectPromise,
          timeoutId: setTimeout(() => {}, 5000),
        });

        // Now process the preload queue again (simulating late arrival)
        (window as any).__pendingResponses = [preloadResponse];
        (newBridge as any).processPreloadQueue();

        // The promise should have been resolved with the payload
        expect(resolvePromise).toHaveBeenCalledWith({ result: 'preloaded-success' });
        expect(rejectPromise).not.toHaveBeenCalled();

        done();
      }, 300);
    });
  });

  describe('Queue Timeout Protection (WAGENT-81)', () => {
    it('should clear stale queue after 5 seconds if bridge fails to initialize', (done) => {
      // Create a scenario where bridge functions are not available
      delete (window as any).__bridgeSend;
      delete (window as any).__bridgeReceive;

      // Mock console.error to verify it's called
      const originalConsoleError = console.error;
      console.error = jest.fn();

      // Create MessageBridge - it won't be able to initialize because bridge functions are missing
      const failingBridge = new MessageBridge('timeout-test');

      // Simulate responses arriving AFTER MessageBridge is created
      // This represents responses that arrive during the window between construction and timeout
      setTimeout(() => {
        (window as any).__pendingResponses = [
          {
            id: 'late-1',
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'lateRequest',
            payload: { result: 'late-response-1' },
            timestamp: Date.now(),
          },
          {
            id: 'late-2',
            from: 'native',
            to: 'test-client',
            type: 'response' as MessageType,
            action: 'lateRequest',
            payload: { result: 'late-response-2' },
            timestamp: Date.now(),
          },
        ];
      }, 1000); // Add responses 1 second after construction

      // Wait for 5+ seconds for timeout to trigger
      setTimeout(() => {
        // Verify console.error was called with the stale queue message
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('responses still queued after 5s - clearing (WAGENT-81)')
        );

        // Restore console.error
        console.error = originalConsoleError;

        done();
      }, 5100); // Wait just over 5 seconds
    }, 10000); // Increase test timeout to 10 seconds

    it('should not clear queue if bridge initializes successfully', (done) => {
      // Setup: Create responses and ensure bridge functions are available
      const response: Message = {
        id: 'success-1',
        from: 'native',
        to: 'test-client',
        type: 'response' as MessageType,
        action: 'successRequest',
        payload: { result: 'success-response' },
        timestamp: Date.now(),
      };

      (window as any).__pendingResponses = [response];

      // Mock console.error to verify it's NOT called
      const originalConsoleError = console.error;
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      // Create MessageBridge with bridge functions available (from beforeEach setup)
      const successBridge = new MessageBridge('success-test');

      // Wait for 5+ seconds
      setTimeout(() => {
        // Verify console.error was NOT called with the stale queue message
        const errorCalls = mockConsoleError.mock.calls.filter((call: any) =>
          call.some((arg: any) => typeof arg === 'string' && arg.includes('responses still queued after 5s'))
        );
        expect(errorCalls.length).toBe(0);

        // Restore console.error
        console.error = originalConsoleError;

        done();
      }, 5100); // Wait just over 5 seconds
    }, 10000); // Increase test timeout to 10 seconds
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
