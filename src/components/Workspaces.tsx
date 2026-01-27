import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { startWorkspaceSession, checkTmuxAvailable } from '@/lib/tauri';
import { EmptyState } from './EmptyState';

export const Workspaces = () => {
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tmuxAvailable, setTmuxAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkTmuxAvailable().then(setTmuxAvailable).catch(console.error);
  }, []);

  const handleSelectDirectory = async () => {
    try {
      setError(null);
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Workspace Directory',
      });
      if (selected && typeof selected === 'string') {
        setSelectedDir(selected);
      }
    } catch (e) {
      console.error('Failed to open directory picker:', e);
      setError('Failed to open directory picker');
    }
  };

  const handleStartSession = async () => {
    if (!selectedDir) return;

    try {
      setIsStarting(true);
      setError(null);
      await startWorkspaceSession(selectedDir);
      setSelectedDir(null);
    } catch (e) {
      console.error('Failed to start session:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsStarting(false);
    }
  };

  const handleClearSelection = () => {
    setSelectedDir(null);
    setError(null);
  };

  if (tmuxAvailable === false) {
    return (
      <div className="flex-1 overflow-y-scroll min-h-0">
        <div className="flex flex-col gap-2">
          <EmptyState
            icon="⚠️"
            message="tmux is not available. Please install tmux and restart the app."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-scroll min-h-0">
      <div className="flex flex-col gap-2">
        {!selectedDir ? (
          <div className="flex flex-col items-center justify-center py-6 gap-3">
            <div className="text-2xl mb-1">📂</div>
            <p className="text-text-secondary text-[0.625rem] text-center mb-2">
              Select a directory to start a new Claude Code session
            </p>
            <button
              onClick={handleSelectDirectory}
              className="px-3 py-1.5 bg-accent-purple text-white text-xs rounded hover:opacity-90 transition-opacity"
            >
              Select Directory
            </button>
          </div>
        ) : (
          <div className="bg-bg-secondary rounded-lg p-3 border-l-2 border-accent-purple">
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[0.6875rem] text-text-primary font-medium truncate">
                    {selectedDir.split('/').pop()}
                  </p>
                  <p
                    className="text-[0.5625rem] text-text-secondary truncate"
                    title={selectedDir}
                  >
                    {selectedDir}
                  </p>
                </div>
                <button
                  onClick={handleClearSelection}
                  className="text-text-secondary hover:text-text-primary text-xs p-1"
                  title="Clear selection"
                >
                  ✕
                </button>
              </div>

              {error && (
                <p className="text-[0.5625rem] text-red-400 bg-red-400/10 px-2 py-1 rounded">
                  {error}
                </p>
              )}

              <div className="flex gap-2 mt-1">
                <button
                  onClick={handleSelectDirectory}
                  className="flex-1 px-2 py-1 bg-bg-primary text-text-secondary text-[0.625rem] rounded hover:bg-opacity-80 transition-opacity border border-border-primary"
                >
                  Change
                </button>
                <button
                  onClick={handleStartSession}
                  disabled={isStarting}
                  className="flex-1 px-2 py-1 bg-accent-purple text-white text-[0.625rem] rounded hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isStarting ? 'Starting...' : 'Start Claude'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
