import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  DashboardData,
  DiffType,
  GitInfo,
  Settings,
  SetupStatus,
  TmuxPane,
  TmuxPaneSize,
} from '@/types';

// Commands
export const getDashboardData = () => invoke<DashboardData>('get_dashboard_data');
export const removeSession = (projectDir: string) => invoke('remove_session', { projectDir });
export const clearAllSessions = () => invoke('clear_all_sessions');
export const getSettings = () => invoke<Settings>('get_settings');
export const getRepoGitInfo = (projectDir: string) =>
  invoke<GitInfo>('get_repo_git_info', { projectDir });

export const getRepoBranches = (projectDir: string) =>
  invoke<string[]>('get_repo_branches', { projectDir });

export type { DiffType };

export const openDiff = (projectDir: string, diffType: DiffType, baseBranch?: string) =>
  invoke('open_diff', { projectDir, diffType, baseBranch });

// Setup commands
export const getSetupStatus = () => invoke<SetupStatus>('get_setup_status');
export const checkClaudeSettings = () => invoke<SetupStatus>('check_claude_settings');
export const openClaudeSettings = () => invoke('open_claude_settings');
export const setWindowSizeForSetup = (enlarged: boolean) =>
  invoke('set_window_size_for_setup', { enlarged });

// Event listeners
export const onStateUpdated = (callback: (data: DashboardData) => void): Promise<UnlistenFn> => {
  return listen<DashboardData>('state-updated', (event) => callback(event.payload));
};

export const onSettingsUpdated = (callback: (settings: Settings) => void): Promise<UnlistenFn> => {
  return listen<Settings>('settings-updated', (event) => callback(event.payload));
};

// Tmux commands
export const tmuxIsAvailable = () => invoke<boolean>('tmux_is_available');
export const tmuxListPanes = () => invoke<TmuxPane[]>('tmux_list_panes');
export const tmuxCapturePane = (paneId: string) => invoke<string>('tmux_capture_pane', { paneId });
export const tmuxSendKeys = (paneId: string, keys: string) =>
  invoke('tmux_send_keys', { paneId, keys });
export const tmuxGetPaneSize = (paneId: string) =>
  invoke<TmuxPaneSize>('tmux_get_pane_size', { paneId });
export const openTmuxViewer = (paneId: string) => invoke('open_tmux_viewer', { paneId });
