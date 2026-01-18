import { useState, useRef, useCallback, useEffect } from 'react';
import { saveNotes } from '@/lib/tauri';

interface NotesProps {
  initialNotes: string;
}

const SAVE_DEBOUNCE_MS = 500;

// Store notes value outside component to persist across remounts
let persistedNotes: string | null = null;

export const Notes = ({ initialNotes }: NotesProps) => {
  // Use persisted value if available, otherwise use initialNotes
  const [notes, setNotes] = useState(() => persistedNotes ?? initialNotes);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPendingChangesRef = useRef(false);

  // Sync to persisted storage whenever notes change
  useEffect(() => {
    persistedNotes = notes;
  }, [notes]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setNotes(newValue);
    hasPendingChangesRef.current = true;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveNotes(newValue).catch(console.error);
      saveTimeoutRef.current = null;
      hasPendingChangesRef.current = false;
    }, SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="mb-2">
      <div className="text-xs text-text-secondary mb-1">Memo</div>
      <textarea
        value={notes}
        onChange={handleChange}
        placeholder="Notes..."
        className="w-full h-[17.5rem] px-2 py-1.5 text-sm bg-bg-card text-text-primary rounded resize-none focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-text-secondary/50"
      />
    </div>
  );
};
