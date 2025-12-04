/**
 * Unit tests for useBridge hooks
 */

import { getBridgeInstance, resetBridgeInstance } from '../hooks/useBridge';
import MessageBridge from '../messageBridge';

// Mock window.webkit for testing
interface MockWebKit {
  messageHandlers: {
    bridge?: {
      postMessage: jest.Mock;
    };
  };
}

describe('useBridge', () => {
  let mockPostMessage: jest.Mock;

  beforeEach(() => {
    // Reset window globals
    delete (window as any).webkit;
    delete (window as any).__bridgeSend;
    delete (window as any).__bridgeReceive;
    delete (window as any).__bridgeHandlers;
    delete (window as any).__messageBridge;
    delete (window as any).resetBridge;

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
    (window as any).__bridgeSend = function (msg: any) {
      mockPostMessage(msg);
    };
    (window as any).__bridgeReceive = function (msg: any) {
      if ((window as any).__bridgeHandlers && (window as any).__bridgeHandlers[msg.action]) {
        (window as any).__bridgeHandlers[msg.action](msg);
      }
    };
    (window as any).__bridgeHandlers = {};
  });

  afterEach(() => {
    // Reset the singleton between tests
    resetBridgeInstance();

    // Cleanup window globals
    delete (window as any).webkit;
    delete (window as any).__bridgeSend;
    delete (window as any).__bridgeReceive;
    delete (window as any).__bridgeHandlers;
    delete (window as any).__messageBridge;
    delete (window as any).resetBridge;
  });

  describe('getBridgeInstance', () => {
    it('should create a new bridge instance if none exists', () => {
      const bridge = getBridgeInstance();
      expect(bridge).toBeInstanceOf(MessageBridge);
      expect(bridge.getClientId()).toBe('popup-default');
    });

    it('should return the same instance on subsequent calls', () => {
      const bridge1 = getBridgeInstance();
      const bridge2 = getBridgeInstance();
      expect(bridge1).toBe(bridge2);
    });

    it('should create bridge with custom clientId', () => {
      const bridge = getBridgeInstance('custom-client');
      expect(bridge.getClientId()).toBe('custom-client');
    });

    it('should reuse existing instance even with different clientId', () => {
      const bridge1 = getBridgeInstance('client-1');
      const bridge2 = getBridgeInstance('client-2');

      // Should return the same instance
      expect(bridge1).toBe(bridge2);
      // Client ID should remain from first creation
      expect(bridge2.getClientId()).toBe('client-1');
    });
  });

  describe('Development Mode Protection', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      // Restore original NODE_ENV
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should warn when reusing existing instance in development mode', () => {
      process.env.NODE_ENV = 'development';

      const bridge1 = getBridgeInstance();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      const bridge2 = getBridgeInstance();

      // Should have logged about returning existing instance
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[useBridge] Returning existing bridge instance:',
        expect.any(String) // instance ID
      );
      expect(bridge1).toBe(bridge2);

      consoleLogSpy.mockRestore();
    });

    it('should not warn on first instance creation in development mode', () => {
      process.env.NODE_ENV = 'development';

      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      getBridgeInstance();

      // Should not log about returning existing instance on first creation
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        '[useBridge] Returning existing bridge instance:',
        expect.any(String)
      );

      consoleLogSpy.mockRestore();
    });

    it('should not warn in production mode', () => {
      process.env.NODE_ENV = 'production';

      const bridge1 = getBridgeInstance();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      const bridge2 = getBridgeInstance();

      // Should NOT log in production mode
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        '[useBridge] Returning existing bridge instance:',
        expect.any(String)
      );
      expect(bridge1).toBe(bridge2);

      consoleLogSpy.mockRestore();
    });

    it('should warn each time existing instance is reused in development', () => {
      process.env.NODE_ENV = 'development';

      const _bridge1 = getBridgeInstance(); // Initialize singleton
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      getBridgeInstance();
      getBridgeInstance();
      getBridgeInstance();

      // Should log 3 times (once for each reuse)
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[useBridge] Returning existing bridge instance:',
        expect.any(String)
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('resetBridgeInstance', () => {
    it('should destroy and nullify the bridge instance', () => {
      const bridge = getBridgeInstance();
      expect(bridge).toBeInstanceOf(MessageBridge);

      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      resetBridgeInstance();

      // Verify reset was logged
      expect(consoleLogSpy).toHaveBeenCalledWith('[useBridge] Bridge instance reset');

      // Verify a new instance is created on next call
      const newBridge = getBridgeInstance();
      expect(newBridge).toBeInstanceOf(MessageBridge);
      expect(newBridge).not.toBe(bridge);

      consoleLogSpy.mockRestore();
    });

    it('should clear pending requests when reset', () => {
      const bridge = getBridgeInstance();

      // Add a pending request
      const mockResolve = jest.fn();
      const mockReject = jest.fn();
      const mockTimeout = setTimeout(() => {}, 5000) as NodeJS.Timeout;

      (bridge as any).pendingRequests.set('request-1', {
        resolve: mockResolve,
        reject: mockReject,
        timeoutId: mockTimeout,
      });

      expect((bridge as any).pendingRequests.size).toBe(1);

      // Reset the bridge
      resetBridgeInstance();

      // Verify pending request was rejected
      expect(mockReject).toHaveBeenCalledWith(new Error('Bridge destroyed'));

      // Cleanup
      clearTimeout(mockTimeout);
    });

    it('should clear all handlers when reset', () => {
      const bridge = getBridgeInstance();

      // Wait for bridge to be ready
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const handler = jest.fn();
          bridge.on('testAction', handler);

          // Verify handler was registered
          expect(window.__bridgeHandlers!['testAction']).toBe(handler);

          // Reset the bridge
          resetBridgeInstance();

          // Verify handlers were cleared
          expect(window.__bridgeHandlers).toEqual({});

          resolve();
        }, 300);
      });
    });

    it('should clear window.__messageBridge when reset', () => {
      const bridge = getBridgeInstance();
      expect(window.__messageBridge).toBe(bridge);

      resetBridgeInstance();

      expect(window.__messageBridge).toBeUndefined();
    });

    it('should do nothing if no instance exists', () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      resetBridgeInstance();

      // Should not log anything since no instance exists
      expect(consoleLogSpy).not.toHaveBeenCalledWith('[useBridge] Bridge instance reset');

      consoleLogSpy.mockRestore();
    });

    it('should expose resetBridge on window for dev tools access', () => {
      // The function is exposed when useBridge module is loaded
      // We need to re-import to trigger the window assignment
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../hooks/useBridge');

      expect((window as any).resetBridge).toBeDefined();
      expect(typeof (window as any).resetBridge).toBe('function');
    });
  });

  describe('Integration with MessageBridge', () => {
    it('should allow creating new instance after reset', () => {
      const bridge1 = getBridgeInstance('client-1');
      expect(bridge1.getClientId()).toBe('client-1');

      resetBridgeInstance();

      const bridge2 = getBridgeInstance('client-2');
      expect(bridge2.getClientId()).toBe('client-2');
      expect(bridge2).not.toBe(bridge1);
    });

    it('should maintain bridge functionality after reset and recreate', () => {
      getBridgeInstance();
      resetBridgeInstance();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const bridge2 = getBridgeInstance();
          const handler = jest.fn();

          bridge2.on('testAction', handler);
          expect(window.__bridgeHandlers!['testAction']).toBe(handler);

          resolve();
        }, 300);
      });
    });
  });
});
