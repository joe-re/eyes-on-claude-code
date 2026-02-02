import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionInfo, GitInfo, Priority } from '@/types';
import { getStatusEmoji, getStatusClass, formatRelativeTime } from '@/lib/utils';
import {
  removeSession,
  renameSession,
  getRepoGitInfo,
  openDiff,
  openTmuxViewer,
  setSessionPriority,
  type DiffType,
} from '@/lib/tauri';
import { ChevronDownIcon } from './icons';
import { DiffButton } from './DiffButton';

const FOCUS_REFRESH_MIN_INTERVAL = 5000;

interface SessionCardProps {
  session: SessionInfo;
}

export const SessionCard = ({ session }: SessionCardProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [isLoadingGit, setIsLoadingGit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relativeTime, setRelativeTime] = useState(() => formatRelativeTime(session.last_event));
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const isLoadingGitRef = useRef(false);
  const lastFocusFetchTimeRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const statusClass = getStatusClass(session.status);
  const displayName = session.custom_name
    ? `${session.project_name}/${session.custom_name}`
    : session.project_name;

  // Update relative time display periodically (every 60 seconds)
  useEffect(() => {
    setRelativeTime(formatRelativeTime(session.last_event));

    const interval = setInterval(() => {
      setRelativeTime(formatRelativeTime(session.last_event));
    }, 60000);

    return () => clearInterval(interval);
  }, [session.last_event]);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const projectKey = session.project_dir || session.project_name;
  const sessionKey = session.tmux_pane ? `${projectKey}:${session.tmux_pane}` : projectKey;

  const handleRemove = async () => {
    try {
      await removeSession(sessionKey);
    } catch (error) {
      console.error('Failed to remove session:', error);
    }
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(session.custom_name || session.project_name);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSaveEdit = async () => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== session.custom_name) {
      try {
        await renameSession(sessionKey, trimmedName);
      } catch (err) {
        console.error('Failed to rename session:', err);
      }
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const fetchGitInfo = useCallback(async () => {
    if (isLoadingGitRef.current) return;
    isLoadingGitRef.current = true;
    setIsLoadingGit(true);
    setError(null);
    try {
      const info = await getRepoGitInfo(session.project_dir);
      setGitInfo(info);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to load git info: ${message}`);
      console.error('Failed to load git info:', err);
    } finally {
      isLoadingGitRef.current = false;
      setIsLoadingGit(false);
    }
  }, [session.project_dir]);

  // Reset git info when session event changes (e.g., after commit)
  useEffect(() => {
    setGitInfo(null);
  }, [session.last_event]);

  // Load git info when expanded
  useEffect(() => {
    if (isExpanded && !gitInfo && !isLoadingGit) {
      fetchGitInfo();
    }
  }, [isExpanded, gitInfo, isLoadingGit, fetchGitInfo]);

  // Refresh git info when window gains focus (only if expanded, with min interval)
  useEffect(() => {
    if (!isExpanded) return;

    const handleFocus = () => {
      const now = Date.now();
      if (now - lastFocusFetchTimeRef.current > FOCUS_REFRESH_MIN_INTERVAL) {
        lastFocusFetchTimeRef.current = now;
        fetchGitInfo();
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isExpanded, fetchGitInfo]);

  const handleDiffClick = async (type: DiffType) => {
    try {
      setError(null);
      // For branch diff, use the detected default branch
      const baseBranch = type === 'branch' ? gitInfo?.default_branch : undefined;
      await openDiff(session.project_dir, type, baseBranch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      console.error('Failed to open diff:', err);
    }
  };

  const handleOpenTmuxViewer = async () => {
    if (!session.tmux_pane) return;
    try {
      setError(null);
      await openTmuxViewer(session.tmux_pane, displayName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to open tmux viewer: ${message}`);
      console.error('Failed to open tmux viewer:', err);
    }
  };

  const handlePriorityChange = async (priority: Priority) => {
    try {
      setError(null);
      await setSessionPriority(sessionKey, priority);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to set priority: ${message}`);
      console.error('Failed to set priority:', err);
    }
  };

  const borderColor = {
    waiting: 'border-l-4 border-warning',
    completed: 'border-l-4 border-info',
    active: 'border-l-4 border-success',
  }[statusClass];

  return (
    <div
      className={`bg-bg-secondary rounded-xl transition-all hover:shadow-lg hover:shadow-black/30 ${borderColor} overflow-hidden`}
    >
      {/* Header - Clickable to expand */}
      <div className="flex items-center p-2 gap-2 cursor-pointer" onClick={handleToggleExpand}>
        <div className="text-base w-6 shrink-0 text-center">{getStatusEmoji(session.status)}</div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-1">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSaveEdit}
                onKeyDown={handleEditKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="font-semibold text-xs bg-bg-card border border-text-secondary/30 rounded px-1 py-0.5 w-full outline-none focus:border-info"
              />
            ) : (
              <>
                <span className="font-semibold truncate text-xs">{displayName}</span>
                {session.priority === 'high' && (
                  <span className="text-[0.5rem] text-red-400 bg-red-400/10 px-1 rounded shrink-0">
                    HIGH
                  </span>
                )}
                {session.priority === 'low' && (
                  <span className="text-[0.5rem] text-blue-300 bg-blue-400/10 px-1 rounded shrink-0">
                    LOW
                  </span>
                )}
                {session.priority === 'operation' && (
                  <span className="text-[0.5rem] text-yellow-400 bg-yellow-400/10 px-1 rounded shrink-0">
                    OPS
                  </span>
                )}
                <button
                  onClick={handleStartEdit}
                  className="text-text-secondary hover:text-white text-[0.5rem] shrink-0 px-1"
                  title="Edit name"
                >
                  ✏️
                </button>
              </>
            )}
          </div>
          <div className="font-mono text-text-secondary truncate text-[0.5rem]">
            {session.project_dir}
          </div>
          {relativeTime && <div className="text-text-secondary text-[0.5rem]">{relativeTime}</div>}
          {session.waiting_for && (
            <div className="text-warning bg-warning/10 rounded inline-block mt-1 truncate max-w-full text-[0.5rem] py-0.5 px-1">
              ⏸ {session.waiting_for}
            </div>
          )}
        </div>
        {session.tmux_pane && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenTmuxViewer();
            }}
            className="text-xs font-semibold text-purple-400 hover:text-purple-300 px-24 py-1.5 bg-purple-400/10 rounded hover:bg-purple-400/20 transition-colors shrink-0"
            title="Display TMUX session"
          >
            TMUX
          </button>
        )}
        <div
          className={`w-4 h-4 flex items-center justify-center transition-transform shrink-0 ${
            isExpanded ? 'rotate-180' : ''
          }`}
        >
          <ChevronDownIcon className="text-text-secondary w-3 h-3" />
        </div>
      </div>

      {/* Expanded content - Git info and actions */}
      {isExpanded && (
        <div className="border-t border-bg-card px-2 py-2 space-y-1.5">
          {error && (
            <div className="text-red-400 bg-red-400/10 rounded px-2 py-1 text-[0.625rem] flex items-center justify-between">
              <span className="truncate">{error}</span>
              <button
                onClick={() => setError(null)}
                className="text-red-400 hover:text-red-300 ml-1 shrink-0"
              >
                ×
              </button>
            </div>
          )}

          {/* Priority selector */}
          <div className="flex items-center justify-between py-0.5">
            <span className="text-text-secondary text-[0.625rem]">priority:</span>
            <div className="flex gap-1">
              <button
                onClick={() => handlePriorityChange('high')}
                className={`text-[0.625rem] px-1.5 py-0.5 rounded transition-colors ${
                  session.priority === 'high'
                    ? 'bg-red-400/20 text-red-400'
                    : 'bg-bg-card text-text-secondary hover:text-white'
                }`}
              >
                High
              </button>
              <button
                onClick={() => handlePriorityChange('medium')}
                className={`text-[0.625rem] px-1.5 py-0.5 rounded transition-colors ${
                  session.priority === 'medium'
                    ? 'bg-blue-400/20 text-blue-400'
                    : 'bg-bg-card text-text-secondary hover:text-white'
                }`}
              >
                Medium
              </button>
              <button
                onClick={() => handlePriorityChange('low')}
                className={`text-[0.625rem] px-1.5 py-0.5 rounded transition-colors ${
                  session.priority === 'low'
                    ? 'bg-blue-400/20 text-blue-300'
                    : 'bg-bg-card text-text-secondary hover:text-white'
                }`}
              >
                Low
              </button>
              <button
                onClick={() => handlePriorityChange('operation')}
                className={`text-[0.625rem] px-1.5 py-0.5 rounded transition-colors ${
                  session.priority === 'operation'
                    ? 'bg-yellow-400/20 text-yellow-400'
                    : 'bg-bg-card text-text-secondary hover:text-white'
                }`}
              >
                Ops
              </button>
            </div>
          </div>

          {isLoadingGit ? (
            <div className="text-text-secondary text-[0.625rem]">Loading git info...</div>
          ) : gitInfo?.is_git_repo ? (
            <>
              {/* Unstaged changes */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-text-secondary text-[0.625rem]">unstaged:</span>
                  <span
                    className={`text-[0.625rem] ${
                      gitInfo.has_unstaged_changes ? 'text-orange-400' : 'text-text-secondary'
                    }`}
                  >
                    {gitInfo.has_unstaged_changes ? 'Changed' : 'No changes'}
                  </span>
                </div>
                {gitInfo.has_unstaged_changes && (
                  <DiffButton onClick={() => handleDiffClick('unstaged')} small />
                )}
              </div>

              {/* Staged changes */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-text-secondary text-[0.625rem]">staged:</span>
                  <span
                    className={`text-[0.625rem] ${
                      gitInfo.has_staged_changes ? 'text-green-400' : 'text-text-secondary'
                    }`}
                  >
                    {gitInfo.has_staged_changes ? 'Changed' : 'No changes'}
                  </span>
                </div>
                {gitInfo.has_staged_changes && (
                  <DiffButton onClick={() => handleDiffClick('staged')} small />
                )}
              </div>

              {/* Latest commit */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-text-secondary text-[0.625rem] shrink-0">commit:</span>
                  <span className="text-info text-[0.625rem] font-mono">
                    #{gitInfo.latest_commit_hash}
                  </span>
                </div>
                <DiffButton onClick={() => handleDiffClick('commit')} small />
              </div>

              {/* Branch */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-text-secondary text-[0.625rem] shrink-0">branch:</span>
                  <span className="text-success text-[0.625rem] truncate">{gitInfo.branch}</span>
                </div>
                <DiffButton onClick={() => handleDiffClick('branch')} small className="shrink-0" />
              </div>
            </>
          ) : (
            <div className="text-text-secondary text-[0.625rem]">Not a git repository</div>
          )}

          {/* tmux pane info */}
          {session.tmux_pane && (
            <div className="pt-1.5 border-t border-bg-card">
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-text-secondary text-[0.625rem]">tmux:</span>
                  <span className="text-purple-400 text-[0.625rem] font-mono">
                    {session.tmux_pane}
                  </span>
                </div>
                <button
                  onClick={handleOpenTmuxViewer}
                  className="text-[0.625rem] text-text-secondary hover:text-white px-1.5 py-0.5 bg-bg-card rounded hover:bg-white/10 transition-colors"
                >
                  Display TMUX session
                </button>
              </div>
            </div>
          )}

          {/* Remove session button */}
          <div className="pt-1.5 border-t border-bg-card">
            <button
              onClick={handleRemove}
              className="w-full py-1 px-2 text-[0.625rem] text-text-secondary hover:text-white hover:bg-red-500/20 rounded transition-colors"
            >
              Remove session
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
