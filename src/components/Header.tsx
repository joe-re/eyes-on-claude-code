import { useState, useEffect, useCallback } from 'react';
import type { SessionInfo } from '@/types';
import { tmuxSendKeys } from '@/lib/tauri';

interface HeaderProps {
  sessions: SessionInfo[];
  onRefresh: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export const Header = ({ sessions, onRefresh, searchQuery, onSearchChange }: HeaderProps) => {
  const [isApproving, setIsApproving] = useState(false);

  const waitingPermissionSessions = sessions.filter(
    (s) => s.status === 'WaitingPermission' && s.tmux_pane
  );
  const waitingCount = sessions.filter(
    (s) => s.status === 'WaitingPermission' || s.status === 'WaitingInput'
  ).length;

  const isWaiting = waitingCount > 0;

  const handleApproveAll = useCallback(async () => {
    if (waitingPermissionSessions.length === 0 || isApproving) return;

    setIsApproving(true);
    try {
      for (const session of waitingPermissionSessions) {
        if (session.tmux_pane) {
          await tmuxSendKeys(session.tmux_pane, 'y');
          await tmuxSendKeys(session.tmux_pane, 'Enter');
        }
      }
    } catch (err) {
      console.error('Failed to approve sessions:', err);
    } finally {
      setIsApproving(false);
    }
  }, [waitingPermissionSessions, isApproving]);

  // Cmd+K shortcut for Approve All
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handleApproveAll();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleApproveAll]);

  return (
    <header className="flex flex-col gap-1.5 pb-1.5 shrink-0">
      <div className="flex justify-between items-center border-b border-bg-card py-1.5 flex-nowrap">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-sm whitespace-nowrap">Eyes on Claude Code</h1>
        </div>
        <div className="flex items-center gap-2">
          {waitingPermissionSessions.length > 0 && (
            <button
              onClick={handleApproveAll}
              disabled={isApproving}
              className="bg-green-600 hover:bg-green-500 disabled:bg-green-800 text-white rounded-lg cursor-pointer transition-colors py-0.5 px-3 text-[0.625rem] font-semibold"
            >
              {isApproving ? 'Approving...' : `Approve All (${waitingPermissionSessions.length})`}
            </button>
          )}
          <div className="flex items-center gap-2 bg-bg-card rounded-full py-0.5 px-2 text-[0.625rem] whitespace-nowrap shrink-0">
            <div
              className={`w-2 h-2 rounded-full bg-success ${isWaiting ? 'bg-warning animate-pulse-slow' : ''}`}
            />
            <span>{isWaiting ? `${waitingCount} waiting` : 'Monitoring'}</span>
          </div>
        </div>
      </div>
      <div className="flex justify-between items-center gap-2">
        <h2 className="font-semibold text-xs shrink-0">Sessions</h2>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search..."
          className="flex-1 min-w-0 px-2 py-0.5 text-xs bg-bg-card text-text-primary rounded focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-text-secondary/50"
        />
        <button
          onClick={onRefresh}
          className="bg-bg-card border-none text-text-primary rounded-lg cursor-pointer transition-colors hover:bg-accent py-0.5 px-2 text-[0.625rem] shrink-0"
        >
          Refresh
        </button>
      </div>
    </header>
  );
};
