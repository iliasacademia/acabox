#import "PanelStyleHelper.h"

@implementation PanelStyleHelper

+ (void)configureAsNonActivatingPopup:(NSPanel*)panel
                         windowLevel:(NSWindowLevel)level
                           hasShadow:(BOOL)hasShadow
                          isOpaque:(BOOL)isOpaque {
    // Background and appearance
    panel.backgroundColor = [NSColor clearColor];
    panel.opaque = isOpaque;
    panel.level = level;
    panel.hasShadow = hasShadow;

    // Collection behavior - stationary, visible on all spaces
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                               NSWindowCollectionBehaviorStationary;

    // CRITICAL: Make panel non-activating so it doesn't steal focus from MS Word
    panel.floatingPanel = YES;
    panel.becomesKeyOnlyIfNeeded = NO;     // Never become key window
    panel.worksWhenModal = YES;            // Continue working even when modal dialogs are present
    panel.hidesOnDeactivate = NO;          // Don't auto-hide when app deactivates
}

+ (void)configureAsNonActivatingPopup:(NSPanel*)panel {
    // Default configuration: floating popup, no shadow, transparent
    [self configureAsNonActivatingPopup:panel
                           windowLevel:NSFloatingWindowLevel + 1
                             hasShadow:NO
                            isOpaque:NO];
}

@end
