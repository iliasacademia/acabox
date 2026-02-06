use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSNotification, NSOperationQueue, NSString};
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

/// Notification types we observe from NSWorkspace.
#[derive(Debug, Clone, Copy)]
pub enum WorkspaceEvent {
    AppLaunched,
    AppTerminated,
    AppActivated,
    AppDeactivated,
}

/// Info extracted from an NSWorkspace notification.
#[derive(Debug, Clone)]
pub struct WorkspaceNotification {
    pub event: WorkspaceEvent,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub pid: i32,
}

/// A token that keeps NSWorkspace notification observers alive.
/// When dropped, observers are removed.
pub struct WorkspaceObserverTokens {
    _tokens: Vec<Retained<AnyObject>>,
}

// Safety: The tokens are only accessed from the main thread via CFRunLoop.
unsafe impl Send for WorkspaceObserverTokens {}
unsafe impl Sync for WorkspaceObserverTokens {}

/// Register for NSWorkspace notifications and route them through a callback.
/// Returns tokens that must be kept alive for the lifetime of monitoring.
pub fn register_workspace_notifications(
    callback: Arc<Mutex<dyn FnMut(WorkspaceNotification) + Send>>,
) -> WorkspaceObserverTokens {
    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();

    let notification_names = [
        ("NSWorkspaceDidLaunchApplicationNotification", WorkspaceEvent::AppLaunched),
        ("NSWorkspaceDidTerminateApplicationNotification", WorkspaceEvent::AppTerminated),
        ("NSWorkspaceDidActivateApplicationNotification", WorkspaceEvent::AppActivated),
        ("NSWorkspaceDidDeactivateApplicationNotification", WorkspaceEvent::AppDeactivated),
    ];

    let mut tokens: Vec<Retained<AnyObject>> = Vec::new();
    let queue = NSOperationQueue::mainQueue();

    for (name_str, event_type) in notification_names {
        let cb = callback.clone();
        let evt = event_type;

        // The objc2 block API expects NonNull<NSNotification>
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let notif_ref = unsafe { notification.as_ref() };
            let notif = extract_notification(notif_ref, evt);
            if let Ok(mut guard) = cb.lock() {
                guard(notif);
            }
        });

        let ns_name = NSString::from_str(name_str);

        let token: Retained<AnyObject> = unsafe {
            let raw_token = center.addObserverForName_object_queue_usingBlock(
                Some(&ns_name),
                None,
                Some(&queue),
                &block,
            );
            // Convert from ProtocolObject<dyn NSObjectProtocol> to AnyObject
            core::mem::transmute(raw_token)
        };

        tokens.push(token);
    }

    WorkspaceObserverTokens { _tokens: tokens }
}

/// Extract app info from an NSWorkspace notification.
fn extract_notification(notification: &NSNotification, event: WorkspaceEvent) -> WorkspaceNotification {
    let mut bundle_id = None;
    let mut app_name = None;
    let mut pid: i32 = 0;

    // The userInfo dictionary contains NSWorkspaceApplicationKey -> NSRunningApplication
    unsafe {
        if let Some(user_info) = notification.userInfo() {
            let app_key = NSString::from_str("NSWorkspaceApplicationKey");
            let key_obj: &AnyObject = &*((&*app_key) as *const NSString as *const AnyObject);
            if let Some(app_obj) = user_info.objectForKey(key_obj) {
                let app: &NSRunningApplication =
                    &*(&*app_obj as *const AnyObject as *const NSRunningApplication);

                if let Some(bid) = app.bundleIdentifier() {
                    bundle_id = Some(bid.to_string());
                }
                if let Some(name) = app.localizedName() {
                    app_name = Some(name.to_string());
                }
                pid = app.processIdentifier();
            }
        }
    }

    WorkspaceNotification {
        event,
        bundle_id,
        app_name,
        pid,
    }
}

/// Check if an app with the given bundle ID is currently running.
/// Returns (pid, app_name) if found.
pub fn find_running_app(bundle_id: &str) -> Option<(i32, String)> {
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();

    let count = apps.len();
    for i in 0..count {
        let app: Retained<NSRunningApplication> = apps.objectAtIndex(i);
        if let Some(bid) = app.bundleIdentifier() {
            if bid.to_string() == bundle_id {
                let name = app
                    .localizedName()
                    .map(|n: Retained<NSString>| n.to_string())
                    .unwrap_or_else(|| bundle_id.to_string());
                return Some((app.processIdentifier(), name));
            }
        }
    }

    None
}

/// Check if the app with the given bundle ID is the frontmost application.
pub fn is_app_frontmost(bundle_id: &str) -> bool {
    let workspace = NSWorkspace::sharedWorkspace();
    if let Some(app) = workspace.frontmostApplication() {
        if let Some(bid) = app.bundleIdentifier() {
            return bid.to_string() == bundle_id;
        }
    }
    false
}
