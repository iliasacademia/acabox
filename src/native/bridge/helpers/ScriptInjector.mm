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
        "(function() {"
        "  console.log('[Bridge Compat] Injecting bridge functions');"
        "  window.__bridgeSend = function(msg) {"
        "    console.log('[Bridge Compat] Sending to native:', msg.action);"
        "    window.webkit.messageHandlers.bridge.postMessage(msg);"
        "  };"
        "  window.__bridgeReceive = function(msg) {"
        "    console.log('[Bridge Compat] Received from native:', msg.action);"
        "    if (window.__bridgeHandlers && window.__bridgeHandlers[msg.action]) {"
        "      window.__bridgeHandlers[msg.action](msg);"
        "    }"
        "  };"
        "  console.log('[Bridge Compat] Functions injected');"
        "})();";
}

@end
