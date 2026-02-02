import { useState, useRef, useCallback, useEffect } from 'react';
import { saveMemoTabs } from '@/lib/tauri';
import type { MemoTab } from '@/types';

interface NotesProps {
  initialTabs: MemoTab[];
  initialActiveTabId: string;
}

const SAVE_DEBOUNCE_MS = 500;

let persistedTabs: MemoTab[] | null = null;
let persistedActiveTabId: string | null = null;

const generateTabId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const getNextTabName = (tabs: MemoTab[]) => {
  const numbers = tabs
    .map((t) => {
      const match = t.name.match(/^Tab (\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);
  const maxNum = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `Tab ${maxNum + 1}`;
};

export const Notes = ({ initialTabs, initialActiveTabId }: NotesProps) => {
  const [tabs, setTabs] = useState<MemoTab[]>(() => {
    if (persistedTabs !== null) return persistedTabs;
    if (initialTabs.length > 0) return initialTabs;
    return [{ id: 'tab-1', name: 'Tab 1', content: '' }];
  });

  const [activeTabId, setActiveTabId] = useState(() => {
    if (persistedActiveTabId !== null) return persistedActiveTabId;
    if (initialActiveTabId) return initialActiveTabId;
    return tabs[0]?.id || 'tab-1';
  });

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    persistedTabs = tabs;
    persistedActiveTabId = activeTabId;
  }, [tabs, activeTabId]);

  const saveToBackend = useCallback((newTabs: MemoTab[], newActiveTabId: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveMemoTabs(newTabs, newActiveTabId).catch(console.error);
      saveTimeoutRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setTabs((prev) => {
        const updated = prev.map((t) => (t.id === activeTabId ? { ...t, content: newContent } : t));
        saveToBackend(updated, activeTabId);
        return updated;
      });
    },
    [activeTabId, saveToBackend]
  );

  const handleAddTab = useCallback(() => {
    const newTab: MemoTab = {
      id: generateTabId(),
      name: getNextTabName(tabs),
      content: '',
    };
    setTabs((prev) => {
      const updated = [...prev, newTab];
      saveToBackend(updated, newTab.id);
      return updated;
    });
    setActiveTabId(newTab.id);
  }, [tabs, saveToBackend]);

  const handleDeleteTab = useCallback(
    (tabId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (tabs.length <= 1) return;

      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        const updated = prev.filter((t) => t.id !== tabId);
        const newActiveId =
          tabId === activeTabId ? updated[Math.max(0, idx - 1)]?.id || updated[0]?.id : activeTabId;
        saveToBackend(updated, newActiveId);
        if (tabId === activeTabId) {
          setActiveTabId(newActiveId);
        }
        return updated;
      });
    },
    [tabs, activeTabId, saveToBackend]
  );

  const handleTabDoubleClick = useCallback((tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditingName(currentName);
  }, []);

  const handleRenameSubmit = useCallback(() => {
    if (!editingTabId) return;
    const trimmedName = editingName.trim();
    if (trimmedName) {
      setTabs((prev) => {
        const updated = prev.map((t) =>
          t.id === editingTabId ? { ...t, name: trimmedName } : t
        );
        saveToBackend(updated, activeTabId);
        return updated;
      });
    }
    setEditingTabId(null);
    setEditingName('');
  }, [editingTabId, editingName, activeTabId, saveToBackend]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        setEditingTabId(null);
        setEditingName('');
      }
    },
    [handleRenameSubmit]
  );

  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  // Keyboard shortcuts: Cmd+1~9
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < tabs.length) {
          e.preventDefault();
          setActiveTabId(tabs[idx].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs]);

  // Mouse-based drag and drop
  const handleMouseDown = useCallback((e: React.MouseEvent, tabId: string) => {
    if (e.button !== 0) return;
    if (editingTabId === tabId) return;

    e.preventDefault();
    setDraggingTabId(tabId);
  }, [editingTabId]);

  useEffect(() => {
    if (!draggingTabId) return;

    const handleMouseMove = (e: MouseEvent) => {
      let foundTarget: string | null = null;

      tabRefs.current.forEach((el, id) => {
        if (id === draggingTabId) return;
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          foundTarget = id;
        }
      });

      setDropTargetId(foundTarget);
    };

    const handleMouseUp = () => {
      if (draggingTabId && dropTargetId && draggingTabId !== dropTargetId) {
        setTabs((prev) => {
          const draggedIdx = prev.findIndex((t) => t.id === draggingTabId);
          const targetIdx = prev.findIndex((t) => t.id === dropTargetId);
          if (draggedIdx === -1 || targetIdx === -1) return prev;

          const updated = [...prev];
          const [dragged] = updated.splice(draggedIdx, 1);
          updated.splice(targetIdx, 0, dragged);
          saveToBackend(updated, activeTabId);
          return updated;
        });
      }
      setDraggingTabId(null);
      setDropTargetId(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingTabId, dropTargetId, activeTabId, saveToBackend]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const setTabRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      tabRefs.current.set(id, el);
    } else {
      tabRefs.current.delete(id);
    }
  }, []);

  return (
    <div className="mb-2">
      <div className="text-xs text-text-secondary mb-1">Memo</div>
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 mb-1 overflow-x-auto">
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            ref={setTabRef(tab.id)}
            data-memo-tab
            onMouseDown={(e) => handleMouseDown(e, tab.id)}
            onClick={() => !draggingTabId && setActiveTabId(tab.id)}
            onDoubleClick={() => handleTabDoubleClick(tab.id, tab.name)}
            className={`
              group flex items-center gap-1 px-2 py-1 text-xs rounded-t cursor-pointer select-none
              transition-colors
              ${tab.id === activeTabId ? 'bg-bg-card text-text-primary' : 'bg-bg-secondary/50 text-text-secondary hover:bg-bg-secondary'}
              ${draggingTabId === tab.id ? 'opacity-50' : ''}
              ${dropTargetId === tab.id ? 'ring-2 ring-accent' : ''}
            `}
          >
            {editingTabId === tab.id ? (
              <input
                ref={editInputRef}
                type="text"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={handleRenameKeyDown}
                className="w-16 bg-transparent text-text-primary text-xs outline-none border-b border-accent"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="text-text-secondary/50 text-[10px] mr-0.5">{idx + 1}</span>
                <span className="max-w-[60px] truncate">{tab.name}</span>
              </>
            )}
            {tabs.length > 1 && editingTabId !== tab.id && (
              <button
                onClick={(e) => handleDeleteTab(tab.id, e)}
                onMouseDown={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-100 ml-0.5 text-text-secondary hover:text-accent transition-opacity"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          onClick={handleAddTab}
          className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-secondary rounded transition-colors"
          title="Add new tab"
        >
          +
        </button>
      </div>
      {/* Text area */}
      <textarea
        value={activeTab?.content || ''}
        onChange={handleContentChange}
        placeholder="Notes..."
        className="w-full h-[15rem] px-2 py-1.5 text-sm bg-bg-card text-text-primary rounded resize-none focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-text-secondary/50"
      />
    </div>
  );
};
