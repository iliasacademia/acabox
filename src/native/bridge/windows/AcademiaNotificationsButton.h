#import <Cocoa/Cocoa.h>
#import "AcademiaNotificationsPopup.h"
#import "../managers/AcademiaManager.h"

// Forward declaration
@class WordAccessibilityObserver;

// AcademiaNotificationsButton: Native button overlay window showing "A" button on selection
@interface AcademiaNotificationsButton : NSPanel <OverlayWindow>

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSButton* button;
@property (nonatomic, strong) NSString* selectedText;
@property (nonatomic, assign) CGRect selectionBounds;  // Store selection bounds for popup positioning
@property (nonatomic, strong) NSView* badgeView;  // Red badge indicator for notifications
@property (nonatomic, strong) NSTextField* badgeLabel;  // Label showing notification count
@property (nonatomic, assign) int badgeCount;  // Current badge count (for debugging)
@property (nonatomic, strong) AcademiaNotificationsPopup* popup;  // Notifications popup window
@property (nonatomic, assign) BOOL popupWasVisible;  // Track if popup should be re-shown after Word state changes

// Polling properties
@property (nonatomic, strong) NSTimer* pollTimer;  // Timer for polling notification count
@property (nonatomic, strong) NSString* apiBaseUrl;  // Base URL for API (e.g., http://127.0.0.1:8080)
@property (nonatomic, strong) NSString* authToken;  // Bearer token for authentication
@property (nonatomic, assign) int lastCount;  // Last fetched notification count

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Button action
- (void)buttonClicked:(id)sender;

// Positioning
- (void)positionAtPoint:(CGPoint)point withHeight:(CGFloat)selectionHeight;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Badge management
- (void)updateBadge:(int)count;
- (int)getBadgeCount;
- (CGRect)getBadgeFrame;

// Polling management
- (void)startPolling;
- (void)stopPolling;

// Cleanup
- (void)orderOut:(id)sender;

@end
