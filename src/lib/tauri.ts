import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
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

export const onWindowFocus = (callback: () => void): Promise<UnlistenFn> => {
  return listen('tauri://focus', callback);
};

// Bring all diff windows to front
export const bringDiffWindowsToFront = async (): Promise<void> => {
  const windows = await getAllWindows();
  const diffWindows = windows.filter((w) => w.label.startsWith('difit-'));

  for (const window of diffWindows) {
    await window.show();
    await window.unminimize();
    await window.setFocus();
  }

  // Re-focus dashboard to keep it on top
  const dashboard = getCurrentWindow();
  await dashboard.setFocus();
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

// Workspace commands
export const startWorkspaceSession = (workingDir: string) =>
  invoke<string>('start_workspace_session', { workingDir });
export const checkTmuxAvailable = () => invoke<boolean>('check_tmux_available');
