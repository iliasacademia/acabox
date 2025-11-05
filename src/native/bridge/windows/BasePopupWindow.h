#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Forward declaration
@class WordAccessibilityObserver;

// BasePopupWindow: Abstract base class for WKWebView-based popup windows
// Provides common functionality for TextPopupWindow and ClickPopupWindow
// Eliminates ~200 lines of duplication by centralizing:
// - WKWebView setup and lifecycle
// - HTML loading
// - Message handling infrastructure
// - Console logging forwarding
// - Focus management (non-activating panels)
@interface BasePopupWindow : NSPanel <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>

// Properties
@property (nonatomic, strong) WKWebView* webView;
@property (nonatomic, weak) WordAccessibilityObserver* observer;  // Weak to avoid retain cycles
@property (nonatomic, strong) NSString* htmlSubpath;  // Subpath for HTML file (e.g., "academiaNotifications" -> dist/popup/academiaNotifications/index.html)

// Initialization
// Subclasses should call this in their init methods
- (instancetype)initWithSize:(CGSize)size
                windowLevel:(NSWindowLevel)level
                   observer:(WordAccessibilityObserver*)observer;

// HTML Loading (uses HTMLLoader helper)
// Subclasses can override to customize loading behavior
- (void)loadPopupHTML;
- (NSString*)windowNameForLogging;  // Override in subclass

// Message handling - subclasses override to handle specific actions
// Called when JavaScript sends messages via window.webkit.messageHandlers
- (void)handleBridgeMessage:(NSDictionary*)message;
- (void)handleConsoleLog:(NSDictionary*)logMessage;

// Focus management
- (BOOL)canBecomeKeyWindow;
- (BOOL)canBecomeMainWindow;

@end
