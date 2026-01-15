import { useState, useEffect, useCallback } from 'react';

export interface WindowSize {
  width: number;
  height: number;
}

const DEBOUNCE_DELAY = 300; // 300ms debounce for resize events

/**
 * Hook for tracking window dimensions with debounced resize events.
 *
 * @returns Current window width and height
 *
 * @example
 * const { width, height } = useWindowSize();
 *
 * // Use width to determine responsive behavior
 * const isMobile = width < 768;
 * const isTablet = width < 1024;
 */
export function useWindowSize(): WindowSize {
  const [windowSize, setWindowSize] = useState<WindowSize>({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const updateSize = useCallback(() => {
    setWindowSize({
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, []);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      // Clear existing timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Debounce: wait 300ms after last resize event
      timeoutId = setTimeout(() => {
        updateSize();
      }, DEBOUNCE_DELAY);
    };

    // Add resize listener
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [updateSize]);

  return windowSize;
}
