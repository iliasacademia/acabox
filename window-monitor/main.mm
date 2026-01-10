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
    fprintf(stderr, "  -h, --help     Show this help message\n");
    fprintf(stderr, "\nDescription:\n");
    fprintf(stderr, "  Monitors Microsoft Word window events and outputs JSON to stdout.\n");
    fprintf(stderr, "  Press Ctrl+C to stop monitoring.\n");
    fprintf(stderr, "\nRequirements:\n");
    fprintf(stderr, "  - Accessibility permissions must be granted\n");
    fprintf(stderr, "  - System Preferences > Privacy & Security > Accessibility\n");
    fprintf(stderr, "\nOutput format:\n");
    fprintf(stderr, "  One JSON object per line for each window event.\n");
    fprintf(stderr, "  Events: WINDOW_EXISTING, WINDOW_CREATED, WINDOW_DESTROYED\n");
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        // Parse arguments
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
                printUsage(argv[0]);
                return 0;
            }
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

        NSLog(@"Window Monitor for Microsoft Word");
        NSLog(@"Press Ctrl+C to stop monitoring");
        NSLog(@"---");

        // Initialize NSApplication (required for NSWorkspace notifications)
        [NSApplication sharedApplication];

        // Start monitoring
        WindowMonitor *monitor = [WindowMonitor sharedMonitor];
        [monitor startMonitoring];

        // Run the event loop
        NSLog(@"Monitoring started. Waiting for Word window events...");

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
