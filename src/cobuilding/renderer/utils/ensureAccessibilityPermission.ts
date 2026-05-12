import React, { useState, useCallback } from 'react';
import { AlertDialog } from 'radix-ui';

/**
 * Hook that gates Word-overlay actions behind an accessibility permission
 * check. Returns a `check()` function and a `modal` element to render.
 *
 * `check()` calls `overlay:ensureReady` on the main process, which:
 *   1. Verifies macOS Accessibility permission
 *   2. Starts the window monitor + webview manager if not already running
 *
 * If permission is missing, the modal is shown with instructions and an
 * "Open Settings" button that opens the exact System Settings pane.
 */
export function useAccessibilityGate() {
  const [open, setOpen] = useState(false);

  const check = useCallback(async (): Promise<boolean> => {
    try {
      const result: any = await window.electronAPI.invoke('overlay:ensureReady');
      if (result?.hasPermission) return true;
    } catch {
      return true;
    }
    setOpen(true);
    return false;
  }, []);

  const handleOpenSettings = useCallback(() => {
    window.electronAPI.invoke('request-accessibility-permission');
  }, []);

  const modal = React.createElement(
    AlertDialog.Root,
    { open, onOpenChange: setOpen },
    React.createElement(AlertDialog.Portal, null,
      React.createElement(AlertDialog.Overlay, { className: 'chatListModalOverlay' }),
      React.createElement(AlertDialog.Content, { className: 'chatListModal' },
        React.createElement(AlertDialog.Title, { className: 'chatListModalTitle' },
          'Accessibility Permission Required'),
        React.createElement(AlertDialog.Description, { className: 'chatListModalDesc' },
          'Academia needs macOS Accessibility permission to show the overlay next to your document. Open System Settings → Privacy & Security → Accessibility and enable Academia. After granting, close this dialog and try again.'),
        React.createElement('div', { className: 'chatListModalActions' },
          React.createElement(AlertDialog.Cancel, { asChild: true },
            React.createElement('button', { className: 'chatListModalBtn chatListModalBtn--secondary' }, 'Cancel')),
          React.createElement(AlertDialog.Action, { asChild: true },
            React.createElement('button', {
              className: 'chatListModalBtn chatListModalBtn--primary',
              onClick: handleOpenSettings,
            }, 'Open Settings')),
        ),
      ),
    ),
  );

  return { check, modal };
}
