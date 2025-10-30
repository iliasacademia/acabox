#import "ScriptInjector.h"

@implementation ScriptInjector

+ (NSString*)consoleLoggingScript {
    return @
        "const originalLog = console.log; "
        "const originalError = console.error; "
        "const originalWarn = console.warn; "
        "console.log = function(...args) { "
        "  originalLog.apply(console, args); "
        "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'log', message: args.join(' ')}); "
        "}; "
        "console.error = function(...args) { "
        "  originalError.apply(console, args); "
        "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'error', message: args.join(' ')}); "
        "}; "
        "console.warn = function(...args) { "
        "  originalWarn.apply(console, args); "
        "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'warn', message: args.join(' ')}); "
        "};";
}

+ (NSString*)bridgeCompatibilityScript {
    return @
        "try { "
        "  console.log('[Bridge Compat] Script executing...'); "
        "  (function() { "
        "    console.log('[Bridge Compat] Injecting bridge functions'); "
        "    "
        "    // Initialize pending responses queue "
        "    window.__pendingResponses = []; "
        "    "
        "    window.__bridgeSend = function(msg) { "
        "      console.log('[Bridge Compat] Sending to native:', msg.action); "
        "      window.webkit.messageHandlers.bridge.postMessage(msg); "
        "    }; "
        "    "
        "    window.__bridgeReceive = function(msg) { "
        "      console.log('[Bridge Compat] Received from native:', msg.action, 'type:', msg.type); "
        "      "
        "      // If MessageBridge has registered itself, forward to it "
        "      if (window.__messageBridge && window.__messageBridge.handleNativeMessage) { "
        "        console.log('[Bridge Compat] Forwarding to MessageBridge'); "
        "        window.__messageBridge.handleNativeMessage(msg); "
        "        return; "
        "      } "
        "      "
        "      // If this is a response but MessageBridge isn't loaded yet, queue it "
        "      if (msg.type === 'response' || msg.type === 'error') { "
        "        console.log('[Bridge Compat] Queueing response for MessageBridge'); "
        "        window.__pendingResponses.push(msg); "
        "        return; "
        "      } "
        "      "
        "      // Handle regular messages with action handlers (backward compatibility) "
        "      if (window.__bridgeHandlers && window.__bridgeHandlers[msg.action]) { "
        "        console.log('[Bridge Compat] Routing to action handler'); "
        "        window.__bridgeHandlers[msg.action](msg); "
        "      } else { "
        "        console.warn('[Bridge Compat] No handler for action:', msg.action); "
        "      } "
        "    }; "
        "    "
        "    console.log('[Bridge Compat] Functions injected'); "
        "  })(); "
        "} catch (e) { "
        "  console.error('[Bridge Compat] ERROR:', e.message, e.stack); "
        "}";
}

@end
