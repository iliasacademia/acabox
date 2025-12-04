/**
 * Bridge Preload Script
 *
 * This script MUST load before any other JavaScript (especially bundle.js)
 * It sets up:
 * 1. Console logging interception (forwards to native)
 * 2. Bridge communication functions (__bridgeSend, __bridgeReceive)
 */

// ===== Console Logging Interception =====
// Intercept console methods and forward to native code
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

// Helper function to format console arguments for native logging
function formatArgsForNative(args) {
  return args.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

console.log = function(...args) {
  originalLog.apply(console, args);
  if (window.webkit && window.webkit.messageHandlers.consoleLog) {
    window.webkit.messageHandlers.consoleLog.postMessage({level: 'log', message: formatArgsForNative(args)});
  }
};

console.error = function(...args) {
  originalError.apply(console, args);
  if (window.webkit && window.webkit.messageHandlers.consoleLog) {
    window.webkit.messageHandlers.consoleLog.postMessage({level: 'error', message: formatArgsForNative(args)});
  }
};

console.warn = function(...args) {
  originalWarn.apply(console, args);
  if (window.webkit && window.webkit.messageHandlers.consoleLog) {
    window.webkit.messageHandlers.consoleLog.postMessage({level: 'warn', message: formatArgsForNative(args)});
  }
};

// ===== Bridge Compatibility Layer =====
try {
  (function() {
    // Initialize pending responses queue
    window.__pendingResponses = [];

    window.__bridgeSend = function(msg) {
      window.webkit.messageHandlers.bridge.postMessage(msg);
    };

    window.__bridgeReceive = function(msg) {
      // If MessageBridge has registered itself, forward to it
      if (window.__messageBridge && window.__messageBridge.handleNativeMessage) {
        window.__messageBridge.handleNativeMessage(msg);
        return;
      }

      // If this is a response but MessageBridge isn't loaded yet, queue it
      if (msg.type === 'response' || msg.type === 'error') {
        window.__pendingResponses.push(msg);

        // WAGENT-80: Warn if queue is growing large
        if (window.__pendingResponses.length > 5) {
          console.warn('[Bridge Compat] WARNING: Queue size growing large:', window.__pendingResponses.length, 'responses pending');
        }
        return;
      }

      // Handle regular messages with action handlers (backward compatibility)
      if (window.__bridgeHandlers && window.__bridgeHandlers[msg.action]) {
        window.__bridgeHandlers[msg.action](msg);
      } else {
        console.warn('[Bridge Compat] No handler for action:', msg.action);
      }
    };
  })();
} catch (e) {
  console.error('[Bridge Compat] ERROR:', e.message, e.stack);
}
