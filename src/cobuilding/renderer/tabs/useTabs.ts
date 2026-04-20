import { useState, useCallback, useRef } from 'react';
import type { TabDescriptor } from './types';

interface TabsState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
}

interface UseTabsOptions {
  onBeforeClose?: (id: string) => void;
}

export function useTabs(options: UseTabsOptions = {}) {
  const [state, setState] = useState<TabsState>({ tabs: [], activeTabId: null });

  // Latest-value ref so closeTab's useCallback identity stays stable and
  // onBeforeClose is never called from inside a setState updater (which React
  // 18 may invoke twice under StrictMode).
  const onBeforeCloseRef = useRef(options.onBeforeClose);
  onBeforeCloseRef.current = options.onBeforeClose;

  const stateRef = useRef(state);
  stateRef.current = state;

  const openTab = useCallback((descriptor: TabDescriptor) => {
    setState((prev) => {
      // If a tab with the same ID already exists, just activate it
      const existingIndex = prev.tabs.findIndex((t) => t.id === descriptor.id);
      if (existingIndex !== -1) {
        return { ...prev, activeTabId: descriptor.id };
      }

      // If this is a preview tab and there's already a preview tab, replace it in-place
      if (!descriptor.pinned) {
        const previewIndex = prev.tabs.findIndex((t) => !t.pinned);
        if (previewIndex !== -1) {
          const newTabs = [...prev.tabs];
          newTabs[previewIndex] = descriptor;
          return { tabs: newTabs, activeTabId: descriptor.id };
        }
      }

      // Otherwise, insert after the active tab (or at the end)
      const activeIndex = prev.tabs.findIndex((t) => t.id === prev.activeTabId);
      const insertIndex = activeIndex !== -1 ? activeIndex + 1 : prev.tabs.length;
      const newTabs = [...prev.tabs];
      newTabs.splice(insertIndex, 0, descriptor);
      return { tabs: newTabs, activeTabId: descriptor.id };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    // Read outside setState so this stays a pure updater.
    const current = stateRef.current;
    const index = current.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    onBeforeCloseRef.current?.(id);

    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const newTabs = prev.tabs.filter((t) => t.id !== id);
      let newActiveId = prev.activeTabId;
      if (prev.activeTabId === id) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (idx < newTabs.length) {
          newActiveId = newTabs[idx].id; // tab to the right
        } else {
          newActiveId = newTabs[newTabs.length - 1].id; // tab to the left
        }
      }
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  }, []);

  const activateTab = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeTabId: id }));
  }, []);

  const pinTab = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, pinned: true } : t)),
    }));
  }, []);

  const deactivateAllTabs = useCallback(() => {
    setState((prev) => ({ ...prev, activeTabId: null }));
  }, []);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    openTab,
    closeTab,
    activateTab,
    pinTab,
    deactivateAllTabs,
  };
}
