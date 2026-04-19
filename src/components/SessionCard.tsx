import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionInfo, GitInfo } from '@/types';
import { getStatusEmoji, getStatusClass, formatRelativeTime } from '@/lib/utils';
import {
  removeSession,
  getRepoGitInfo,
  getRepoBranches,
  openDiff,
  openTmuxViewer,
  type DiffType,
} from '@/lib/tauri';
import { ChevronDownIcon } from './icons';
import { DiffButton, type DiffButtonState } from './DiffButton';
import { BranchCombobox } from './BranchCombobox';

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
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBaseBranch, setSelectedBaseBranch] = useState<string>('');
  const [loadingDiffType, setLoadingDiffType] = useState<DiffType | null>(null);
  const isLoadingGitRef = useRef(false);
  const lastFocusFetchTimeRef = useRef(0);

  const statusClass = getStatusClass(session.status);

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

  const handleRemove = async () => {
    try {
      await removeSession(session.project_dir);
    } catch (error) {
      console.error('Failed to remove session:', error);
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

  // Reset git info and branches when session event changes (e.g., after commit)
  useEffect(() => {
    setGitInfo(null);
    setBranches([]);
    setSelectedBaseBranch('');
  }, [session.last_event]);

  // Initialize selectedBaseBranch when gitInfo loads
  useEffect(() => {
    if (gitInfo?.default_branch && !selectedBaseBranch) {
      setSelectedBaseBranch(gitInfo.default_branch);
    }
  }, [gitInfo?.default_branch, selectedBaseBranch]);

  // Fetch branches when expanded
  useEffect(() => {
    if (isExpanded && branches.length === 0) {
      getRepoBranches(session.project_dir)
        .then(setBranches)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          setError(`Failed to load branches: ${message}`);
        });
    }
  }, [isExpanded, branches.length, session.project_dir]);

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
    if (loadingDiffType) return;
    try {
      setError(null);
      setLoadingDiffType(type);
      const baseBranch =
        type === 'branch' ? selectedBaseBranch || gitInfo?.default_branch : undefined;
      await openDiff(session.project_dir, type, baseBranch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      console.error('Failed to open diff:', err);
    } finally {
      setLoadingDiffType(null);
    }
  };

  const diffButtonState = (type: DiffType): DiffButtonState => {
    if (loadingDiffType === null) return 'idle';
    return loadingDiffType === type ? 'loading' : 'blocked';
  };

  const handleOpenTmuxViewer = async () => {
    if (!session.tmux_pane) return;
    try {
      setError(null);
      await openTmuxViewer(session.tmux_pane);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to open tmux viewer: ${message}`);
      console.error('Failed to open tmux viewer:', err);
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
          <div className="font-semibold truncate text-xs">{session.project_name}</div>
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
                  <DiffButton
                    onClick={() => handleDiffClick('unstaged')}
                    small
                    state={diffButtonState('unstaged')}
                  />
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
                  <DiffButton
                    onClick={() => handleDiffClick('staged')}
                    small
                    state={diffButtonState('staged')}
                  />
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
                <DiffButton
                  onClick={() => handleDiffClick('commit')}
                  small
                  state={diffButtonState('commit')}
                />
              </div>

              {/* Branch */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-text-secondary text-[0.625rem] shrink-0">branch:</span>
                  <span className="text-success text-[0.625rem] truncate">{gitInfo.branch}</span>
                </div>
              </div>

              {/* Branch diff target */}
              <div className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-text-secondary text-[0.625rem] shrink-0">diff vs:</span>
                  {branches.length > 0 && (
                    <BranchCombobox
                      branches={branches}
                      value={selectedBaseBranch || gitInfo.default_branch}
                      onSelect={setSelectedBaseBranch}
                    />
                  )}
                </div>
                <DiffButton
                  onClick={() => handleDiffClick('branch')}
                  small
                  state={diffButtonState('branch')}
                  className="shrink-0"
                />
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
