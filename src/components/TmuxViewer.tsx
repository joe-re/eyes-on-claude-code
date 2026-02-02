import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { AnsiUp } from 'ansi_up';
import { tmuxCapturePane, tmuxSendKeys, tmuxSendLiteral, tmuxGetPaneSize, tmuxGetCursorPosition } from '@/lib/tauri';

const POLLING_INTERVAL = 500;
const CHAR_WIDTH = 9.5;
const WINDOW_HEIGHT = 800;
const WINDOW_PADDING = 80;
const MIN_WINDOW_WIDTH = 1000;
const MAX_WINDOW_WIDTH = 2000;

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
  const [inputBuffer, setInputBuffer] = useState('');
  const [composingText, setComposingText] = useState('');
  const contentRef = useRef<HTMLPreElement>(null);
  const prevContentRef = useRef<string>('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const isMountedRef = useRef(true);
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

  const sendKeysToTmux = useCallback(
    async (keys: string) => {
      if (!keys) return;
      try {
        await tmuxSendKeys(paneId, keys);
        loadContent().catch(console.error);
      } catch (err) {
        console.error('Failed to send keys:', err);
      }
    },
    [paneId, loadContent]
  );

  const sendLiteralToTmux = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        await tmuxSendLiteral(paneId, text);
        loadContent().catch(console.error);
      } catch (err) {
        console.error('Failed to send text:', err);
      }
    },
    [paneId, loadContent]
  );

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error('Failed to close window:', err);
    }
  };

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      // Ignore during IME composition
      if (isComposingRef.current || e.isComposing) {
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

      // 'c' key copies selected text (only if no buffer)
      if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && !inputBuffer) {
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
        await sendKeysToTmux(tmuxKey);
        return;
      }

      // Enter - send buffered text or Enter key
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inputBuffer) {
          await sendLiteralToTmux(inputBuffer);
          setInputBuffer('');
        } else {
          await sendKeysToTmux('Enter');
        }
        return;
      }

      // Shift+Enter sends literal newline
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        await sendKeysToTmux('C-v');
        await sendKeysToTmux('C-j');
        return;
      }

      // Escape - clear buffer or send Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        if (inputBuffer) {
          setInputBuffer('');
        } else {
          await sendKeysToTmux('Escape');
        }
        return;
      }

      // Backspace - remove last character from buffer or send Backspace
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (inputBuffer) {
          setInputBuffer((prev) => prev.slice(0, -1));
        } else {
          await sendKeysToTmux('BSpace');
        }
        return;
      }

      // Handle other special keys (only when buffer is empty)
      const specialKeyMap: Record<string, string> = {
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
        if (!inputBuffer) {
          await sendKeysToTmux(specialKeyMap[e.key]);
        }
        return;
      }

      // Regular character keys - let hidden input handle it for IME support
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        inputRef.current?.focus();
        // Don't preventDefault - let the input receive the keystroke
        return;
      }
    },
    [inputBuffer, sendKeysToTmux, sendLiteralToTmux]
  );

  const handleCopy = useCallback((e: ClipboardEvent) => {
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      e.preventDefault();
      e.clipboardData?.setData('text/plain', selection.toString());
    }
  }, []);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      setComposingText('');

      const text = e.data;
      if (text) {
        setInputBuffer((prev) => prev + text);
      }
      // Clear the input after composition
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    },
    []
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // During IME composition, show the composing text
      if (isComposingRef.current) {
        setComposingText(value);
        return;
      }
      // For non-IME input (English), add to buffer and clear input
      if (value) {
        setInputBuffer((prev) => prev + value);
        e.target.value = '';
      }
    },
    []
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        // Add pasted text to buffer
        setInputBuffer((prev) => prev + text);
      }
    },
    []
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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

  useEffect(() => {
    const handleWindowFocus = () => {
      inputRef.current?.focus();
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);

  // Handle file drag and drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let lastDropTime = 0;

    listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
      // Debounce: ignore drops within 500ms of last drop
      const now = Date.now();
      if (now - lastDropTime < 500) {
        return;
      }
      lastDropTime = now;

      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        // Add file paths to input buffer
        const pathsText = paths.join(' ');
        setInputBuffer((prev) => (prev ? prev + ' ' + pathsText : pathsText));
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

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

  // Show buffer in overlay
  const showOverlay = inputBuffer || composingText;

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

      {/* Input buffer overlay */}
      {showOverlay && (
        <div className="absolute bottom-12 left-2 px-3 py-2 bg-cyan-900/90 text-cyan-200 text-sm font-mono rounded shadow-lg">
          {inputBuffer}
          {composingText && (
            <span className="border-b border-cyan-400">{composingText}</span>
          )}
          <span className="animate-pulse">|</span>
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

      {/* Hidden input for IME composition */}
      <input
        ref={inputRef}
        type="text"
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
