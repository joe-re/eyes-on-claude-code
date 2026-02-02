// Session status matching Rust enum
export type SessionStatus = 'Active' | 'WaitingPermission' | 'WaitingInput' | 'Completed';

// Priority matching Rust enum (lowercase from serde)
export type Priority = 'high' | 'medium' | 'low' | 'operation';

// Notification type matching Rust enum (snake_case from serde)
export type NotificationType = 'permission_prompt' | 'idle_prompt' | 'other';

// Event type matching Rust enum (snake_case from serde)
export type EventType =
  | 'session_start'
  | 'session_end'
  | 'notification'
  | 'stop'
  | 'post_tool_use'
  | 'user_prompt_submit'
  | 'unknown';

export interface SessionInfo {
  session_id: string;
  project_name: string;
  project_dir: string;
  status: SessionStatus;
  last_event: string;
  waiting_for: string;
  tmux_pane: string;
  custom_name: string;
  priority: Priority;
}

export interface EventInfo {
  timestamp: string;
  event: EventType;
  matcher: string;
  project_name: string;
  project_dir: string;
  session_id: string;
  message: string;
  notification_type: NotificationType;
  tool_name: string;
  tmux_pane: string;
}

export interface MemoTab {
  id: string;
  name: string;
  content: string;
}

export interface DashboardData {
  sessions: SessionInfo[];
  events: EventInfo[];
  notes: string;
  memoTabs: MemoTab[];
  activeTabId: string;
}

export interface Settings {
  always_on_top: boolean;
  opacity_active: number;
  opacity_inactive: number;
  sound_enabled: boolean;
}

export interface GitInfo {
  branch: string;
  default_branch: string;
  latest_commit_hash: string;
  latest_commit_time: string;
  has_unstaged_changes: boolean;
  has_staged_changes: boolean;
  is_git_repo: boolean;
}

// Diff type for difit integration
export type DiffType = 'unstaged' | 'staged' | 'commit' | 'branch';

// Tmux pane information
export interface TmuxPane {
  session_name: string;
  window_index: number;
  window_name: string;
  pane_index: number;
  pane_id: string;
  is_active: boolean;
}

// Tmux pane size (columns x rows)
export interface TmuxPaneSize {
  width: number;
  height: number;
}

// Tmux cursor position
export interface TmuxCursorPosition {
  x: number;
  y: number;
  history_size: number;
}

// Status of each individual hook type
export interface HookStatus {
  session_start: boolean;
  session_end: boolean;
  stop: boolean;
  post_tool_use: boolean;
  user_prompt_submit: boolean;
  notification_permission: boolean;
  notification_idle: boolean;
}

// Setup status for installation flow
export interface SetupStatus {
  hook_installed: boolean;
  hook_path: string;
  hooks: HookStatus;
  merged_settings: string;
  init_error: string | null;
}
