#ifndef ClickProcessingState_h
#define ClickProcessingState_h

// WAGENT-78: State machine for click processing
// Replaces boolean flag + arbitrary delays with proper state management
typedef NS_ENUM(NSInteger, ClickProcessingState) {
    ClickStateIdle,              // No click processing in progress
    ClickStateProcessing,        // Click event being processed
    ClickStateAwaitingResponse,  // Waiting for response from handler
    ClickStateComplete           // Processing complete, ready to transition to idle
};

#endif /* ClickProcessingState_h */
