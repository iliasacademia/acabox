#import "WindowInfo.h"

@implementation WindowBounds

- (instancetype)initWithRect:(CGRect)rect {
    self = [super init];
    if (self) {
        _x = rect.origin.x;
        _y = rect.origin.y;
        _width = rect.size.width;
        _height = rect.size.height;
    }
    return self;
}

- (NSDictionary *)toDictionary {
    return @{
        @"x": @(self.x),
        @"y": @(self.y),
        @"width": @(self.width),
        @"height": @(self.height)
    };
}

@end

@implementation AppInfo

- (instancetype)initWithName:(NSString *)name identifier:(NSString *)identifier identifierType:(NSString *)identifierType pid:(pid_t)pid {
    self = [super init];
    if (self) {
        _name = [name copy];
        _identifier = [identifier copy];
        _identifierType = [identifierType copy];
        _pid = pid;
    }
    return self;
}

- (NSDictionary *)toDictionary {
    return @{
        @"name": self.name ?: [NSNull null],
        @"identifier": self.identifier ?: [NSNull null],
        @"identifierType": self.identifierType ?: @"bundleId",
        @"pid": @(self.pid)
    };
}

@end

@implementation WindowInfo

- (NSDictionary *)toDictionary {
    return @{
        @"id": self.windowId ?: [NSNull null],
        @"title": self.title ?: [NSNull null],
        @"bounds": self.bounds ? [self.bounds toDictionary] : [NSNull null],
        @"documentPath": self.documentPath ?: [NSNull null]
    };
}

@end

@implementation WindowEvent

- (instancetype)initWithEventType:(WindowEventType)eventType app:(AppInfo *)app window:(WindowInfo *)window {
    self = [super init];
    if (self) {
        _eventType = eventType;
        _app = app;
        _window = window;
        _platform = @"macos";

        // Generate ISO 8601 timestamp
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
        formatter.timeZone = [NSTimeZone timeZoneWithName:@"UTC"];
        _timestamp = [formatter stringFromDate:[NSDate date]];
    }
    return self;
}

+ (NSString *)eventTypeToString:(WindowEventType)eventType {
    switch (eventType) {
        case WindowEventTypeCreated:
            return @"WINDOW_CREATED";
        case WindowEventTypeDestroyed:
            return @"WINDOW_DESTROYED";
        case WindowEventTypeInitial:
            return @"WINDOW_EXISTING";
        case WindowEventTypeFocused:
            return @"WINDOW_FOCUSED";
        case WindowEventTypeRepositioning:
            return @"WINDOW_REPOSITIONING";
        case WindowEventTypeRepositioned:
            return @"WINDOW_REPOSITIONED";
        case WindowEventTypeAppFocused:
            return @"APP_FOCUSED";
        case WindowEventTypeAppUnfocused:
            return @"APP_UNFOCUSED";
        case WindowEventTypeAppLaunched:
            return @"APP_LAUNCHED";
        case WindowEventTypeAppTerminated:
            return @"APP_TERMINATED";
        case WindowEventTypeAppExisting:
            return @"APP_EXISTING";
    }
}

- (NSString *)toJSON {
    // Build JSON string manually to control key order
    NSMutableString *json = [NSMutableString string];
    [json appendString:@"{"];
    [json appendFormat:@"\"event\":\"%@\",", [WindowEvent eventTypeToString:self.eventType]];
    [json appendFormat:@"\"timestamp\":\"%@\",", self.timestamp];
    [json appendFormat:@"\"platform\":\"%@\",", self.platform];

    // App object
    NSError *error;
    NSData *appData = [NSJSONSerialization dataWithJSONObject:[self.app toDictionary] options:0 error:&error];
    if (appData) {
        [json appendFormat:@"\"app\":%@,", [[NSString alloc] initWithData:appData encoding:NSUTF8StringEncoding]];
    }

    // Window object
    NSData *windowData = [NSJSONSerialization dataWithJSONObject:[self.window toDictionary] options:0 error:&error];
    if (windowData) {
        [json appendFormat:@"\"window\":%@", [[NSString alloc] initWithData:windowData encoding:NSUTF8StringEncoding]];
    }

    [json appendString:@"}"];
    return json;
}

- (NSString *)toAppJSON {
    // Build JSON string for app-level events (no window info)
    NSMutableString *json = [NSMutableString string];
    [json appendString:@"{"];
    [json appendFormat:@"\"event\":\"%@\",", [WindowEvent eventTypeToString:self.eventType]];
    [json appendFormat:@"\"timestamp\":\"%@\",", self.timestamp];
    [json appendFormat:@"\"platform\":\"%@\",", self.platform];

    // App object
    NSError *error;
    NSData *appData = [NSJSONSerialization dataWithJSONObject:[self.app toDictionary] options:0 error:&error];
    if (appData) {
        [json appendFormat:@"\"app\":%@", [[NSString alloc] initWithData:appData encoding:NSUTF8StringEncoding]];
    }

    [json appendString:@"}"];
    return json;
}

@end
