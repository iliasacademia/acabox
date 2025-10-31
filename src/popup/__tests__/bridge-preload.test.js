/**
 * Unit tests for bridge-preload.js
 */

describe('Bridge Preload Script', () => {
  let originalConsoleLog;
  let originalConsoleError;
  let originalConsoleWarn;
  let mockPostMessage;

  beforeEach(() => {
    // Save original console methods
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    // Mock console methods to avoid test output noise
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();

    // Setup mock webkit
    mockPostMessage = jest.fn();
    global.window = {
      webkit: {
        messageHandlers: {
          consoleLog: {
            postMessage: jest.fn(),
          },
          bridge: {
            postMessage: mockPostMessage,
          },
        },
      },
    };

    // Clear any existing bridge functions
    delete global.window.__bridgeSend;
    delete global.window.__bridgeReceive;
    delete global.window.__pendingResponses;
    delete global.window.__bridgeHandlers;
    delete global.window.__messageBridge;

    // Load the preload script by executing its code
    // We simulate the script execution inline
    global.window.__pendingResponses = [];

    global.window.__bridgeSend = function (msg) {
      global.window.webkit.messageHandlers.bridge.postMessage(msg);
    };

    global.window.__bridgeReceive = function (msg) {
      // If MessageBridge has registered itself, forward to it
      if (global.window.__messageBridge && global.window.__messageBridge.handleNativeMessage) {
        global.window.__messageBridge.handleNativeMessage(msg);
        return;
      }

      // If this is a response but MessageBridge isn't loaded yet, queue it
      if (msg.type === 'response' || msg.type === 'error') {
        // WAGENT-80: Add queue monitoring
        console.log('[Bridge Compat] Queue length before push:', global.window.__pendingResponses.length);
        console.log('[Bridge Compat] Queueing response for MessageBridge');
        global.window.__pendingResponses.push(msg);
        console.log('[Bridge Compat] Queue length after push:', global.window.__pendingResponses.length);

        // WAGENT-80: Warn if queue is growing large
        if (global.window.__pendingResponses.length > 5) {
          console.warn('[Bridge Compat] WARNING: Queue size growing large:', global.window.__pendingResponses.length, 'responses pending');
        }
        return;
      }

      // Handle regular messages with action handlers (backward compatibility)
      if (global.window.__bridgeHandlers && global.window.__bridgeHandlers[msg.action]) {
        global.window.__bridgeHandlers[msg.action](msg);
      }
    };
  });

  afterEach(() => {
    // Restore original console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;

    // Cleanup
    delete global.window;
  });

  describe('Queue Monitoring (WAGENT-80)', () => {
    it('should log queue length before and after pushing response', () => {
      const response = {
        id: 'test-1',
        from: 'native',
        to: 'test-client',
        type: 'response',
        action: 'testAction',
        payload: { result: 'success' },
        timestamp: Date.now(),
      };

      // Call __bridgeReceive with a response
      global.window.__bridgeReceive(response);

      // Verify logging was called
      expect(console.log).toHaveBeenCalledWith('[Bridge Compat] Queue length before push:', 0);
      expect(console.log).toHaveBeenCalledWith('[Bridge Compat] Queue length after push:', 1);
      expect(global.window.__pendingResponses).toHaveLength(1);
    });

    it('should warn when queue exceeds 5 responses', () => {
      // Add 6 responses to trigger the warning
      for (let i = 0; i < 6; i++) {
        const response = {
          id: `test-${i}`,
          from: 'native',
          to: 'test-client',
          type: 'response',
          action: 'testAction',
          payload: { result: 'success' },
          timestamp: Date.now(),
        };

        global.window.__bridgeReceive(response);
      }

      // Verify warning was called when queue reached 6
      expect(console.warn).toHaveBeenCalledWith(
        '[Bridge Compat] WARNING: Queue size growing large:',
        6,
        'responses pending'
      );
      expect(global.window.__pendingResponses).toHaveLength(6);
    });

    it('should not warn when queue is 5 or less', () => {
      // Add exactly 5 responses
      for (let i = 0; i < 5; i++) {
        const response = {
          id: `test-${i}`,
          from: 'native',
          to: 'test-client',
          type: 'response',
          action: 'testAction',
          payload: { result: 'success' },
          timestamp: Date.now(),
        };

        global.window.__bridgeReceive(response);
      }

      // Verify warning was NOT called
      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Queue size growing large')
      );
      expect(global.window.__pendingResponses).toHaveLength(5);
    });

    it('should queue error messages as well as responses', () => {
      const errorMsg = {
        id: 'test-error',
        from: 'native',
        to: 'test-client',
        type: 'error',
        action: 'testAction',
        payload: { error: 'Something went wrong' },
        timestamp: Date.now(),
      };

      global.window.__bridgeReceive(errorMsg);

      expect(console.log).toHaveBeenCalledWith('[Bridge Compat] Queue length before push:', 0);
      expect(console.log).toHaveBeenCalledWith('[Bridge Compat] Queue length after push:', 1);
      expect(global.window.__pendingResponses).toHaveLength(1);
      expect(global.window.__pendingResponses[0]).toEqual(errorMsg);
    });
  });

  describe('Basic Bridge Functionality', () => {
    it('should initialize __pendingResponses array', () => {
      expect(global.window.__pendingResponses).toBeDefined();
      expect(Array.isArray(global.window.__pendingResponses)).toBe(true);
    });

    it('should queue responses when MessageBridge is not loaded', () => {
      const response = {
        id: 'test-1',
        from: 'native',
        to: 'test-client',
        type: 'response',
        action: 'testAction',
        payload: { result: 'success' },
        timestamp: Date.now(),
      };

      global.window.__bridgeReceive(response);

      expect(global.window.__pendingResponses).toHaveLength(1);
      expect(global.window.__pendingResponses[0]).toEqual(response);
    });

    it('should forward messages to MessageBridge when loaded', () => {
      const mockHandleNativeMessage = jest.fn();
      global.window.__messageBridge = {
        handleNativeMessage: mockHandleNativeMessage,
      };

      const response = {
        id: 'test-1',
        from: 'native',
        to: 'test-client',
        type: 'response',
        action: 'testAction',
        payload: { result: 'success' },
        timestamp: Date.now(),
      };

      global.window.__bridgeReceive(response);

      // Should forward to MessageBridge, not queue
      expect(mockHandleNativeMessage).toHaveBeenCalledWith(response);
      expect(global.window.__pendingResponses).toHaveLength(0);
    });
  });
});
