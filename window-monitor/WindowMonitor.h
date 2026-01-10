#ifndef WINDOW_MONITOR_H
#define WINDOW_MONITOR_H

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "WindowInfo.h"

// Bundle ID for Microsoft Word
static NSString * const kMicrosoftWordBundleId = @"com.microsoft.Word";

@interface WindowMonitor : NSObject

// Singleton accessor
+ (instancetype)sharedMonitor;

// Start monitoring Word windows
- (void)startMonitoring;

// Stop monitoring
- (void)stopMonitoring;

// Check if accessibility permissions are granted
+ (BOOL)hasAccessibilityPermission;

// Request accessibility permissions (opens System Preferences)
+ (void)requestAccessibilityPermission;

@end

#endif /* WINDOW_MONITOR_H */
