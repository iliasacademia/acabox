#ifndef WORD_ACCESSIBILITY_BRIDGE_H
#define WORD_ACCESSIBILITY_BRIDGE_H

#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>

// Logging function that writes to both NSLog and the app's log file
// Must call SetLogFilePath first to enable file logging
void AcademiaLog(NSString* format, ...) NS_FORMAT_FUNCTION(1,2);

// Forward declarations
typedef void (*SelectionChangedCallback)(const char* text, CGRect bounds);
typedef void (*ScrollEventCallback)(bool isScrolling);
typedef void (*ButtonClickCallback)(const char* text);

@interface WordAccessibilityObserver : NSObject

- (instancetype)initWithPID:(pid_t)pid;
- (BOOL)startObserving:(SelectionChangedCallback)selectionCallback
         scrollCallback:(ScrollEventCallback)scrollCallback
      buttonClickCallback:(ButtonClickCallback)buttonClickCallback
                  error:(NSError**)error;
- (void)stopObserving;
- (NSDictionary*)getSelectedText;
- (NSDictionary*)getFirstTextAreaInfo;
- (NSDictionary*)findTextPosition:(NSString*)searchText;
- (pid_t)getWordPID;
- (AXUIElementRef)getWordApp;
- (BOOL)focusDocument;
- (BOOL)checkAccessibilityPermission;
- (void)handleButtonClick;
- (void)handleButtonClickWithAction:(NSString*)action text:(NSString*)text;
- (CGRect)getScrollAreaBounds;
- (void)updateBadgeCountViaManager:(NSInteger)count;

// Accessor methods for managers
- (id)getAcademiaManager;
- (id)getWordAdapter;

@end

#endif // WORD_ACCESSIBILITY_BRIDGE_H
