#ifndef WINDOW_INFO_H
#define WINDOW_INFO_H

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

typedef NS_ENUM(NSInteger, WindowEventType) {
    WindowEventTypeCreated,
    WindowEventTypeDestroyed,
    WindowEventTypeInitial,       // For windows that exist when monitoring starts
    WindowEventTypeFocused,          // When a window becomes focused/active
    WindowEventTypeRepositioning,    // When window bounds change begins (resize or move)
    WindowEventTypeRepositioned,     // When window bounds change ends (resize or move)
    WindowEventTypeAppFocused,    // When Word app becomes frontmost
    WindowEventTypeAppUnfocused,  // When Word app loses focus
    WindowEventTypeAppLaunched,   // When Word app launches
    WindowEventTypeAppTerminated, // When Word app terminates
    WindowEventTypeAppExisting    // When Word app is already running at monitor start
};

@interface WindowBounds : NSObject
@property (nonatomic, assign) CGFloat x;
@property (nonatomic, assign) CGFloat y;
@property (nonatomic, assign) CGFloat width;
@property (nonatomic, assign) CGFloat height;

- (instancetype)initWithRect:(CGRect)rect;
- (NSDictionary *)toDictionary;
@end

@interface AppInfo : NSObject
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *bundleId;
@property (nonatomic, assign) pid_t pid;

- (instancetype)initWithName:(NSString *)name bundleId:(NSString *)bundleId pid:(pid_t)pid;
- (NSDictionary *)toDictionary;
@end

@interface WindowInfo : NSObject
@property (nonatomic, assign) CGWindowID windowId;
@property (nonatomic, strong) WindowBounds *bounds;
@property (nonatomic, copy) NSString *role;
@property (nonatomic, copy) NSString *subrole;
@property (nonatomic, copy) NSString *documentPath;

- (NSDictionary *)toDictionary;
@end

@interface WindowEvent : NSObject
@property (nonatomic, assign) WindowEventType eventType;
@property (nonatomic, copy) NSString *timestamp;
@property (nonatomic, strong) AppInfo *app;
@property (nonatomic, strong) WindowInfo *window;

- (instancetype)initWithEventType:(WindowEventType)eventType app:(AppInfo *)app window:(WindowInfo *)window;
- (NSString *)toJSON;
- (NSString *)toAppJSON;  // For app-level events (no window info)
+ (NSString *)eventTypeToString:(WindowEventType)eventType;
@end

#endif /* WINDOW_INFO_H */
