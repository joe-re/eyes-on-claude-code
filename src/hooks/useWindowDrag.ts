import { useEffect } from 'react';

// Use global Tauri object (same as original implementation)
declare global {
  interface Window {
    __TAURI__?: {
      window?: {
        getCurrentWindow: () => {
          startDragging: () => Promise<void>;
        };
      };
    };
  }
}

export const useWindowDrag = () => {
  useEffect(() => {
    // Use document.querySelector exactly like the original implementation
    const container = document.querySelector('.container') as HTMLElement | null;
    if (!container) return;

    const handleMouseDown = async (e: MouseEvent) => {
      // Check for mini-view mode by checking DOM class (exactly like original)
      if (!document.body.classList.contains('mini-view')) return;

      // Get appWindow fresh on each mousedown
      const appWindow = window.__TAURI__?.window?.getCurrentWindow();
      if (!appWindow) return;

      const target = e.target as HTMLElement;

      // Don't drag when clicking on buttons or interactive elements
      if (
        target.tagName === 'BUTTON' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'INPUT' ||
        target.classList.contains('remove-btn') ||
        target.classList.contains('refresh-btn') ||
        target.closest('button') ||
        target.closest('.remove-btn') ||
        target.closest('textarea') ||
        target.closest('input')
      ) {
        return;
      }

      // Only left mouse button
      if (e.buttons === 1) {
        try {
          await appWindow.startDragging();
        } catch (error) {
          console.error('Failed to start dragging:', error);
        }
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    return () => container.removeEventListener('mousedown', handleMouseDown);
  }, []);
};
