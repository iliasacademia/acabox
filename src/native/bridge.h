#ifndef WORD_ACCESSIBILITY_BRIDGE_H
#define WORD_ACCESSIBILITY_BRIDGE_H

#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>

// Logging function that writes to both NSLog and the app's log file
// Must call SetLogFilePath first to enable file logging
void AcademiaLog(NSString* format, ...) NS_FORMAT_FUNCTION(1,2);

#endif // WORD_ACCESSIBILITY_BRIDGE_H
