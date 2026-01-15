import { useState, useEffect, useCallback, useRef } from 'react';

const COLLAPSE_BREAKPOINT = 1280; // Window width below which sidebar auto-collapses

export interface UseSidebarCollapseResult {
  collapsed: boolean;
  toggleCollapsed: () => void;
}

/**
 * Hook for managing sidebar collapse state with responsive auto-collapse behavior.
 *
 * @param windowWidth - Current window width from useWindowSize hook
 * @returns Collapsed state and toggle function
 *
 * @example
 * const windowSize = useWindowSize();
 * const { collapsed, toggleCollapsed } = useSidebarCollapse(windowSize.width);
 *
 * // collapsed will be true when window < 1280px (unless manually toggled)
 * // Manual toggle persists until window crosses breakpoint
 */
export function useSidebarCollapse(windowWidth: number): UseSidebarCollapseResult {
  const [collapsed, setCollapsed] = useState(false);
  const [isManualToggle, setIsManualToggle] = useState(false);
  const previousWidthRef = useRef(windowWidth);

  // Handle window resize auto-collapse
  useEffect(() => {
    const previousWidth = previousWidthRef.current;
    const crossedBreakpoint =
      (previousWidth >= COLLAPSE_BREAKPOINT && windowWidth < COLLAPSE_BREAKPOINT) ||
      (previousWidth < COLLAPSE_BREAKPOINT && windowWidth >= COLLAPSE_BREAKPOINT);

    // Reset manual toggle flag when crossing breakpoint
    if (crossedBreakpoint) {
      setIsManualToggle(false);
    }

    // Auto-collapse logic (only if not manually toggled)
    if (!isManualToggle) {
      if (windowWidth < COLLAPSE_BREAKPOINT) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    }

    previousWidthRef.current = windowWidth;
  }, [windowWidth, isManualToggle]);

  // Manual toggle handler
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
    setIsManualToggle(true);
  }, []);

  return {
    collapsed,
    toggleCollapsed,
  };
}
