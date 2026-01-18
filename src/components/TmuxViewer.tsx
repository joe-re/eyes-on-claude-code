import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { AnsiUp } from 'ansi_up';
import { tmuxCapturePane, tmuxSendKeys, tmuxGetPaneSize, tmuxGetCursorPosition } from '@/lib/tauri';

const POLLING_INTERVAL = 500;
// Approximate width of monospace character at text-sm (14px) with font-mono
const CHAR_WIDTH = 9.5;
const WINDOW_HEIGHT = 800;
const WINDOW_PADDING = 80;
const MIN_WINDOW_WIDTH = 1000;
const MAX_WINDOW_WIDTH = 2000;
// Delay before sending typed text to allow IME composition to start
const IME_DETECTION_DELAY = 50;

interface TmuxViewerProps {
  paneId: string;
}

export const TmuxViewer = ({ paneId }: TmuxViewerProps) => {
  const [content, setContent] = useState<string>('');
  const [cursorPos, setCursorPos] = useState<{ x: number; line: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFadedIn, setIsFadedIn] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const prevContentRef = useRef<string>('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const justComposedRef = useRef(false);
  const isMountedRef = useRef(true);
  const flushTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingTextRef = useRef('');
  const userScrolledUpRef = useRef(false);

  const ansiUp = useMemo(() => {
    const instance = new AnsiUp();
    instance.use_classes = true;
    return instance;
  }, []);

  const htmlContent = useMemo(() => {
    return ansiUp.ansi_to_html(content);
  }, [ansiUp, content]);

  const loadContent = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      const [newContent, cursor] = await Promise.all([
        tmuxCapturePane(paneId),
        tmuxGetCursorPosition(paneId),
      ]);
      if (!isMountedRef.current) return;
      if (newContent !== prevContentRef.current) {
        setContent(newContent);
        prevContentRef.current = newContent;
      }
      setCursorPos({ x: cursor.x, line: cursor.history_size + cursor.y });
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [paneId]);

  const flushPendingText = useCallback(async () => {
    const text = pendingTextRef.current;
    if (text && !isComposingRef.current) {
      try {
        await tmuxSendKeys(paneId, text);
        loadContent().catch(console.error);
      } catch (err) {
        console.error('Failed to send text:', err);
      }
    }
    pendingTextRef.current = '';
    setInputValue('');
  }, [paneId, loadContent]);

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error('Failed to close window:', err);
    }
  };

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      // Ignore during IME composition or right after composition end
      if (isComposingRef.current || e.isComposing || justComposedRef.current) {
        return;
      }

      // Ignore modifier-only keys
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        return;
      }

      // Cmd+C - allow browser copy handling
      if (e.metaKey && e.key.toLowerCase() === 'c') {
        return;
      }

      // Cmd+V - focus hidden input and let paste event handle it
      if (e.metaKey && e.key.toLowerCase() === 'v') {
        inputRef.current?.focus();
        return;
      }

      // Cmd+W closes the viewer
      if (e.metaKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        handleClose();
        return;
      }

      // 'c' key copies selected text
      if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey) {
        const selection = window.getSelection();
        if (selection && selection.toString()) {
          navigator.clipboard.writeText(selection.toString()).catch(console.error);
          return;
        }
      }

      // Handle Ctrl+key combinations
      if (e.ctrlKey && e.key.length === 1) {
        e.preventDefault();
        const tmuxKey = `C-${e.key.toLowerCase()}`;
        try {
          await tmuxSendKeys(paneId, tmuxKey);
          loadContent().catch(console.error);
        } catch (err) {
          console.error('Failed to send key:', err);
        }
        return;
      }

      // Shift+Enter sends literal newline for Claude Code multi-line input
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        try {
          // Send Ctrl+V followed by Ctrl+J to insert literal newline
          await tmuxSendKeys(paneId, 'C-v');
          await tmuxSendKeys(paneId, 'C-j');
          loadContent().catch(console.error);
        } catch (err) {
          console.error('Failed to send newline:', err);
        }
        return;
      }

      // Handle special keys
      const specialKeyMap: Record<string, string> = {
        Enter: 'Enter',
        Escape: 'Escape',
        Backspace: 'BSpace',
        Tab: 'Tab',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        Delete: 'DC',
        Insert: 'IC',
        F1: 'F1',
        F2: 'F2',
        F3: 'F3',
        F4: 'F4',
        F5: 'F5',
        F6: 'F6',
        F7: 'F7',
        F8: 'F8',
        F9: 'F9',
        F10: 'F10',
        F11: 'F11',
        F12: 'F12',
      };

      if (specialKeyMap[e.key]) {
        e.preventDefault();
        try {
          await tmuxSendKeys(paneId, specialKeyMap[e.key]);
          loadContent().catch(console.error);
        } catch (err) {
          console.error('Failed to send key:', err);
        }
        return;
      }

      // For regular character keys (single characters), let them go to the hidden input
      // This allows IME composition to work properly
      if (e.key.length === 1) {
        inputRef.current?.focus();
        // Don't prevent default - let the input receive the keystroke
        return;
      }
    },
    [paneId, loadContent]
  );

  const handleCopy = useCallback((e: ClipboardEvent) => {
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      e.preventDefault();
      e.clipboardData?.setData('text/plain', selection.toString());
    }
  }, []);

  const handleCompositionStart = useCallback(() => {
    // Cancel any pending text flush when IME composition starts
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    pendingTextRef.current = '';
    isComposingRef.current = true;
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback(
    async (e: React.CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      setIsComposing(false);
      justComposedRef.current = true;

      // Send the composed text to tmux as a single string
      const text = e.data;
      if (text) {
        try {
          await tmuxSendKeys(paneId, text);
          // Refresh immediately after sending composed text
          loadContent().catch(console.error);
        } catch (err) {
          console.error('Failed to send composed text:', err);
        }
      }

      // Clear input
      setInputValue('');

      // Delay to prevent the Enter key from compositionend being processed by handleKeyDown.
      // 100ms is sufficient to skip the keydown event that immediately follows compositionend.
      setTimeout(() => {
        justComposedRef.current = false;
      }, 100);
    },
    [paneId, loadContent]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInputValue(newValue);

      // If composing, let composition handle it
      if (isComposingRef.current) {
        return;
      }

      // Accumulate text
      pendingTextRef.current = newValue;

      // Clear existing timeout
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
      }

      // Set timeout to flush - this gives IME a chance to start composition
      flushTimeoutRef.current = setTimeout(() => {
        flushPendingText();
        flushTimeoutRef.current = null;
      }, IME_DETECTION_DELAY);
    },
    [flushPendingText]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        try {
          await tmuxSendKeys(paneId, text);
          loadContent().catch(console.error);
        } catch (err) {
          console.error('Failed to paste text:', err);
        }
      }
    },
    [paneId, loadContent]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Clear any pending text flush on unmount
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
      }
    };
  }, []);

  // Get pane size and resize window width to match
  useEffect(() => {
    const resizeWindowToPane = async () => {
      try {
        const size = await tmuxGetPaneSize(paneId);
        const calculatedWidth = Math.round(size.width * CHAR_WIDTH + WINDOW_PADDING);
        const windowWidth = Math.min(MAX_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, calculatedWidth));
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(windowWidth, WINDOW_HEIGHT));
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    };
    resizeWindowToPane();
  }, [paneId]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  useEffect(() => {
    window.addEventListener('copy', handleCopy);
    return () => window.removeEventListener('copy', handleCopy);
  }, [handleCopy]);

  // Refocus hidden input when window gains focus (for IME support)
  useEffect(() => {
    const handleWindowFocus = () => {
      inputRef.current?.focus();
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);

  // Refocus hidden input on any click within the window
  const handleContainerClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    loadContent();
    const timer = setTimeout(() => setIsFadedIn(true), 50);
    return () => clearTimeout(timer);
  }, [loadContent]);

  useEffect(() => {
    const intervalId = setInterval(loadContent, POLLING_INTERVAL);
    return () => clearInterval(intervalId);
  }, [loadContent]);

  useEffect(() => {
    if (contentRef.current && !userScrolledUpRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content]);

  return (
    <div
      className={`relative flex h-screen flex-col bg-bg-primary transition-opacity duration-300 ${
        isFadedIn ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleContainerClick}
    >
      {error && (
        <div className="mx-2 mt-2 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-hidden p-2 pb-16">
        {isLoading && !content ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            Loading...
          </div>
        ) : (
          <div className="relative h-full">
            <pre
              ref={contentRef}
              className="ansi-content h-full overflow-y-auto overflow-x-auto whitespace-pre rounded bg-black/50 p-3 font-mono text-sm text-text-primary select-text cursor-text"
              dangerouslySetInnerHTML={{ __html: htmlContent || '(empty)' }}
              onClick={(e) => e.stopPropagation()}
              onScroll={(e) => {
                const el = e.currentTarget;
                setScrollTop(el.scrollTop);
                const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
                userScrolledUpRef.current = !isAtBottom;
              }}
              onCopy={(e) => {
                const selection = window.getSelection();
                if (selection && selection.toString()) {
                  e.preventDefault();
                  e.clipboardData.setData('text/plain', selection.toString());
                }
              }}
            />
            {cursorPos && (
              <div
                className="pointer-events-none absolute animate-pulse"
                style={{
                  left: `${12 + cursorPos.x * 8.4}px`,
                  top: `${12 + cursorPos.line * 20 - scrollTop}px`,
                  width: '2px',
                  height: '18px',
                  backgroundColor: '#22d3ee',
                  boxShadow: '0 0 4px #22d3ee',
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* IME composition overlay - only shown during composition */}
      {isComposing && inputValue && (
        <div className="absolute bottom-12 left-2 px-3 py-2 bg-cyan-900/90 text-cyan-200 text-sm font-mono rounded shadow-lg">
          {inputValue}
        </div>
      )}

      {/* Close button */}
      <button
        type="button"
        onClick={handleClose}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-bg-card px-8 py-2 text-base text-text-secondary hover:bg-white/20 hover:text-text-primary transition-colors"
      >
        Close
      </button>

      {/* Hidden input for IME and text input */}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        className="absolute opacity-0 pointer-events-none"
        style={{ left: '-9999px' }}
        autoFocus
      />
    </div>
  );
};
