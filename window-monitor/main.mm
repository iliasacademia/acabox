#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <signal.h>
#import "WindowMonitor.h"

static volatile BOOL shouldExit = NO;

void signalHandler(int signal) {
    if (signal == SIGINT || signal == SIGTERM) {
        shouldExit = YES;
        NSLog(@"\nReceived signal %d, shutting down...", signal);
        CFRunLoopStop(CFRunLoopGetMain());
    }
}

void printUsage(const char *programName) {
    fprintf(stderr, "Usage: %s [options]\n", programName);
    fprintf(stderr, "\nOptions:\n");
    fprintf(stderr, "  -b, --bundle-id <id>  Bundle ID of the app to monitor (default: com.microsoft.Word)\n");
    fprintf(stderr, "  -h, --help            Show this help message\n");
    fprintf(stderr, "\nExamples:\n");
    fprintf(stderr, "  %s                                    # Monitor Microsoft Word (default)\n", programName);
    fprintf(stderr, "  %s --bundle-id com.apple.Preview      # Monitor Preview\n", programName);
    fprintf(stderr, "  %s -b com.microsoft.Powerpoint        # Monitor PowerPoint\n", programName);
    fprintf(stderr, "\nDescription:\n");
    fprintf(stderr, "  Monitors window events for the specified app and outputs JSON to stdout.\n");
    fprintf(stderr, "  Press Ctrl+C to stop monitoring.\n");
    fprintf(stderr, "\nRequirements:\n");
    fprintf(stderr, "  - Accessibility permissions must be granted\n");
    fprintf(stderr, "  - System Preferences > Privacy & Security > Accessibility\n");
    fprintf(stderr, "\nOutput format:\n");
    fprintf(stderr, "  One JSON object per line for each window event.\n");
    fprintf(stderr, "  Events: APP_EXISTING, APP_LAUNCHED, APP_TERMINATED, APP_FOCUSED, APP_UNFOCUSED,\n");
    fprintf(stderr, "          WINDOW_EXISTING, WINDOW_CREATED, WINDOW_DESTROYED, WINDOW_FOCUSED,\n");
    fprintf(stderr, "          WINDOW_REPOSITIONING, WINDOW_REPOSITIONED\n");
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSString *bundleId = nil;

        // Parse arguments
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
                printUsage(argv[0]);
                return 0;
            } else if (strcmp(argv[i], "-b") == 0 || strcmp(argv[i], "--bundle-id") == 0) {
                if (i + 1 < argc) {
                    bundleId = [NSString stringWithUTF8String:argv[i + 1]];
                    i++;  // Skip the next argument since we consumed it
                } else {
                    fprintf(stderr, "Error: %s requires an argument\n", argv[i]);
                    printUsage(argv[0]);
                    return 1;
                }
            } else {
                fprintf(stderr, "Error: Unknown option '%s'\n", argv[i]);
                printUsage(argv[0]);
                return 1;
            }
        }

        // Default to Microsoft Word if no bundle ID specified
        if (!bundleId) {
            bundleId = @"com.microsoft.Word";
        }

        // Set up signal handlers
        signal(SIGINT, signalHandler);
        signal(SIGTERM, signalHandler);

        // Check accessibility permissions
        if (![WindowMonitor hasAccessibilityPermission]) {
            fprintf(stderr, "ERROR: Accessibility permissions not granted.\n");
            fprintf(stderr, "Please grant accessibility permissions in:\n");
            fprintf(stderr, "  System Preferences > Privacy & Security > Accessibility\n");
            fprintf(stderr, "\nOpening System Preferences...\n");
            [WindowMonitor requestAccessibilityPermission];
            return 1;
        }

        NSLog(@"Window Monitor for %@", bundleId);
        NSLog(@"Press Ctrl+C to stop monitoring");
        NSLog(@"---");

        // Initialize NSApplication (required for NSWorkspace notifications)
        [NSApplication sharedApplication];

        // Start monitoring
        WindowMonitor *monitor = [[WindowMonitor alloc] initWithBundleId:bundleId];
        [monitor startMonitoring];

        // Run the event loop
        NSLog(@"Monitoring started. Waiting for window events...");

        while (!shouldExit) {
            @autoreleasepool {
                // Process events for a short interval
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                         beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
            }
        }

        // Clean up
        [monitor stopMonitoring];
        NSLog(@"Monitor stopped.");

        return 0;
    }
}
