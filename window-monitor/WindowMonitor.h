#ifndef WINDOW_MONITOR_H
#define WINDOW_MONITOR_H

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "WindowInfo.h"

// Default bundle ID (Microsoft Word) for backwards compatibility
static NSString * const kDefaultBundleId = @"com.microsoft.Word";

@interface WindowMonitor : NSObject

// Target application bundle identifier
@property (nonatomic, copy) NSString *targetBundleId;

// Display name for the app (auto-detected from NSRunningApplication if not set)
@property (nonatomic, copy) NSString *appDisplayName;

// Initialize with a specific bundle ID
- (instancetype)initWithBundleId:(NSString *)bundleId;

// Start monitoring windows for the target app
- (void)startMonitoring;

// Stop monitoring
- (void)stopMonitoring;

// Check if accessibility permissions are granted
+ (BOOL)hasAccessibilityPermission;

// Request accessibility permissions (opens System Preferences)
+ (void)requestAccessibilityPermission;

@end

#endif /* WINDOW_MONITOR_H */
