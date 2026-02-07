#import "bridge.h"
#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>

// Global variable for log file path
static NSString* globalLogFilePath = nil;
static NSFileHandle* globalLogFileHandle = nil;

// Custom logging function that writes to both NSLog and file
// (declared in bridge.h for use in other files)
void AcademiaLog(NSString* format, ...) {
    va_list args;
    va_start(args, format);
    NSString* message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);

    // Always log to NSLog (system console)
    NSLog(@"%@", message);

    // Also write to file if configured
    if (globalLogFileHandle) {
        NSDateFormatter* formatter = [[NSDateFormatter alloc] init];
        [formatter setDateFormat:@"yyyy-MM-dd HH:mm:ss.SSS"];
        NSString* timestamp = [formatter stringFromDate:[NSDate date]];
        NSString* logLine = [NSString stringWithFormat:@"[%@] [NATIVE] %@\n", timestamp, message];

        @try {
            [globalLogFileHandle writeData:[logLine dataUsingEncoding:NSUTF8StringEncoding]];
            [globalLogFileHandle synchronizeFile];
        } @catch (NSException* e) {
            NSLog(@"[NATIVE] Failed to write to log file: %@", e.reason);
        }
    }
}

// Node-API bindings
namespace {

Napi::Value CheckPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
    BOOL hasPermission = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Value GetAppInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *bundleId = [mainBundle bundleIdentifier] ?: @"(no bundle identifier)";
    NSString *executablePath = [[NSProcessInfo processInfo] arguments][0] ?: @"(unknown)";

    // Get code signing information including TeamIdentifier
    NSString *teamId = @"(not set)";
    SecCodeRef code = NULL;
    OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &code);
    if (status == errSecSuccess && code != NULL) {
        CFDictionaryRef signingInfo = NULL;
        status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signingInfo);
        if (status == errSecSuccess && signingInfo != NULL) {
            NSString *teamIdValue = (NSString *)CFDictionaryGetValue(signingInfo, kSecCodeInfoTeamIdentifier);
            if (teamIdValue) {
                teamId = teamIdValue;
            }
            CFRelease(signingInfo);
        }
        CFRelease(code);
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("bundleId", Napi::String::New(env, [bundleId UTF8String]));
    result.Set("executablePath", Napi::String::New(env, [executablePath UTF8String]));
    result.Set("teamId", Napi::String::New(env, [teamId UTF8String]));

    return result;
}

Napi::Value RequestPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Check permission without showing system prompt (we open System Settings manually)
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
    BOOL hasPermission = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);

    // Log permission status and app info
    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *bundleId = [mainBundle bundleIdentifier] ?: @"(no bundle identifier)";
    NSString *executablePath = [[NSProcessInfo processInfo] arguments][0] ?: @"(unknown)";

    AcademiaLog(@"[WORD-INTEGRATION] Accessibility permission request:");
    AcademiaLog(@"[WORD-INTEGRATION]   - Permission granted: %@", hasPermission ? @"YES" : @"NO");
    AcademiaLog(@"[WORD-INTEGRATION]   - Bundle identifier: %@", bundleId);
    AcademiaLog(@"[WORD-INTEGRATION]   - Executable path: %@", executablePath);

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Value OpenAccessibilitySettings(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    AcademiaLog(@"[WORD-INTEGRATION] Opening System Settings > Privacy & Security > Accessibility...");
    NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"];
    [[NSWorkspace sharedWorkspace] openURL:url];

    return env.Undefined();
}

Napi::Value ResetAndRequestPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *bundleId = [mainBundle bundleIdentifier] ?: @"com.electron.academia-electron";

    // Build the tccutil command
    NSString *command = [NSString stringWithFormat:@"tccutil reset Accessibility %@", bundleId];

    // Use AppleScript to run tccutil with admin privileges
    // This will show a native macOS password prompt
    NSString *script = [NSString stringWithFormat:
        @"do shell script \"%@\" with administrator privileges", command];

    NSDictionary *errorInfo = nil;
    NSAppleScript *appleScript = [[NSAppleScript alloc] initWithSource:script];
    NSAppleEventDescriptor *result = [appleScript executeAndReturnError:&errorInfo];

    BOOL resetSuccess = (result != nil);

    // Open Accessibility settings regardless (user may have cancelled but still wants to manage permissions)
    NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"];
    [[NSWorkspace sharedWorkspace] openURL:url];

    Napi::Object resultObj = Napi::Object::New(env);
    resultObj.Set("resetSuccess", Napi::Boolean::New(env, resetSuccess));
    resultObj.Set("bundleId", Napi::String::New(env, [bundleId UTF8String]));

    return resultObj;
}

Napi::Value SetLogFilePath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (path: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string pathStr = info[0].As<Napi::String>().Utf8Value();
    globalLogFilePath = [NSString stringWithUTF8String:pathStr.c_str()];

    // Close existing file handle if any
    if (globalLogFileHandle) {
        [globalLogFileHandle closeFile];
        globalLogFileHandle = nil;
    }

    // Create the file if it doesn't exist
    NSFileManager* fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:globalLogFilePath]) {
        [fileManager createFileAtPath:globalLogFilePath contents:nil attributes:nil];
    }

    // Open file handle for appending
    globalLogFileHandle = [NSFileHandle fileHandleForWritingAtPath:globalLogFilePath];
    if (globalLogFileHandle) {
        [globalLogFileHandle seekToEndOfFile];
        AcademiaLog(@"[WORD-INTEGRATION] Native logging initialized to file: %@", globalLogFilePath);
        return Napi::Boolean::New(env, true);
    } else {
        NSLog(@"[NATIVE] Failed to open log file: %@", globalLogFilePath);
        return Napi::Boolean::New(env, false);
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("requestPermission", Napi::Function::New(env, RequestPermission));
    exports.Set("openAccessibilitySettings", Napi::Function::New(env, OpenAccessibilitySettings));
    exports.Set("resetAndRequestPermission", Napi::Function::New(env, ResetAndRequestPermission));
    exports.Set("getAppInfo", Napi::Function::New(env, GetAppInfo));
    exports.Set("setLogFilePath", Napi::Function::New(env, SetLogFilePath));
    return exports;
}

} // namespace

NODE_API_MODULE(word_accessibility, Init)
