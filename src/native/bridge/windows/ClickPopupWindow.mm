#import "ClickPopupWindow.h"

@implementation ClickPopupWindow

- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer {
    // Fixed size for popup - will contain React UI
    CGFloat width = 500;
    CGFloat height = 400;

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel + 2  // Above the hover popup
                      observer:observer];
    if (self) {
        self.count = count;
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (NSString*)windowNameForLogging {
    return @"ClickPopupWindow";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[ClickPopupWindow WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle button clicks
    if ([action isEqualToString:@"buttonClick"]) {
        NSDictionary* payload = message[@"payload"];
        NSString* btnAction = payload[@"action"];
        NSNumber* count = payload[@"count"];

        // Forward to observer which will send to main.ts
        if (self.observer) {
            id observer = self.observer;
            if ([btnAction isEqualToString:@"seeMore"]) {
                NSString* msg = [NSString stringWithFormat:@"seeMore|count:%@", count];
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [observer performSelector:@selector(handleButtonClickWithAction:text:)
                               withObject:@"seeMore" withObject:msg];
                #pragma clang diagnostic pop
            } else if ([btnAction isEqualToString:@"dismiss"]) {
                NSString* msg = [NSString stringWithFormat:@"dismiss|count:%@", count];
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [observer performSelector:@selector(handleButtonClickWithAction:text:)
                               withObject:@"dismiss" withObject:msg];
                #pragma clang diagnostic pop
                // Also hide the popup
                [self orderOut:nil];
                [self stopGlobalMouseMonitor];
            }
        }

        // Send response back to JavaScript
        NSString* responseJS = [NSString stringWithFormat:@
            "window.__bridgeReceive({"
            "  id: '%@',"
            "  type: 'response',"
            "  action: 'buttonClick',"
            "  payload: {success: true}"
            "});",
            message[@"id"]];

        [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
            if (error) {
                NSLog(@"[ClickPopupWindow] Error sending response: %@", error);
            }
        }];
    } else if ([action isEqualToString:@"close"]) {
        [self orderOut:nil];
        [self stopGlobalMouseMonitor];
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Wait for React to initialize then send initial content
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self updateContentWithCount:self.count];
    });
}

#pragma mark - Content Update

- (void)updateContentWithCount:(int)count {
    self.count = count;

    // Send count data to React via bridge with type: 'suggestions'
    NSString* js = [NSString stringWithFormat:@
        "try { "
        "  console.log('[Native->JS] Sending updateContent via bridge'); "
        "  if (window.__bridgeReceive) { "
        "    window.__bridgeReceive({ "
        "      id: 'native-' + Date.now(), "
        "      from: 'native', "
        "      to: 'popup', "
        "      type: 'event', "
        "      action: 'updateContent', "
        "      payload: { "
        "        type: 'suggestions', "
        "        count: %d, "
        "        text: 'Count: %d' "
        "      }, "
        "      timestamp: Date.now() "
        "    }); "
        "    console.log('[Native->JS] Bridge message sent successfully'); "
        "  } else { "
        "    console.error('[Native->JS] Bridge not found'); "
        "  } "
        "} catch (e) { "
        "  console.error('[Native->JS] Error sending message:', e); "
        "}", count, count];

    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[ClickPopupWindow] Error evaluating JavaScript: %@", error.localizedDescription);
        }
    }];
}

#pragma mark - Global Mouse Monitor

- (void)startGlobalMouseMonitor {
    // Don't create multiple monitors
    if (self.globalMouseMonitor) {
        return;
    }

    // Create a weak reference to self to avoid retain cycles
    __weak ClickPopupWindow* weakSelf = self;

    self.globalMouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
                                                                      handler:^(NSEvent *event) {
        ClickPopupWindow* strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }

        // Get the click location in screen coordinates
        NSPoint clickLocation = [NSEvent mouseLocation];

        // Check if click is outside the popup window
        NSRect popupFrame = strongSelf.frame;
        if (!NSPointInRect(clickLocation, popupFrame)) {
            [strongSelf orderOut:nil];
            [strongSelf stopGlobalMouseMonitor];
        }
    }];
}

- (void)stopGlobalMouseMonitor {
    if (self.globalMouseMonitor) {
        [NSEvent removeMonitor:self.globalMouseMonitor];
        self.globalMouseMonitor = nil;
    }
}

#pragma mark - Cleanup

- (void)dealloc {
    // Stop global mouse monitor
    [self stopGlobalMouseMonitor];

    // Base class handles WKWebView cleanup
    // But we need to ensure our monitor is stopped first
}

@end
