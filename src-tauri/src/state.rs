use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    SessionStart,
    SessionEnd,
    Notification,
    Stop,
    PostToolUse,
    UserPromptSubmit,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationType {
    PermissionPrompt,
    IdlePrompt,
    #[serde(other)]
    #[default]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventInfo {
    pub timestamp: String,
    #[serde(rename = "event")]
    pub event_type: EventType,
    pub matcher: String,
    pub project_name: String,
    pub project_dir: String,
    pub session_id: String,
    pub message: String,
    #[serde(default)]
    pub notification_type: NotificationType,
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub tmux_pane: String,
    #[serde(default)]
    pub npx_path: String,
    #[serde(default)]
    pub tmux_path: String,
    #[serde(default)]
    pub custom_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    #[default]
    Medium,
    Low,
    Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(default)]
    pub session_id: String,
    pub project_name: String,
    pub project_dir: String,
    pub status: SessionStatus,
    pub last_event: String,
    #[serde(default)]
    pub waiting_for: String,
    #[serde(default)]
    pub tmux_pane: String,
    #[serde(default)]
    pub custom_name: String,
    #[serde(default)]
    pub priority: Priority,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SessionStatus {
    Active,
    WaitingPermission,
    WaitingInput,
    Completed,
}

impl SessionStatus {
    pub fn emoji(&self) -> &str {
        match self {
            SessionStatus::Active => "🟢",
            SessionStatus::WaitingPermission => "🔐",
            SessionStatus::WaitingInput => "⏳",
            SessionStatus::Completed => "✅",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTab {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub sessions: Vec<SessionInfo>,
    pub events: Vec<EventInfo>,
    pub notes: String,
    pub memo_tabs: Vec<MemoTab>,
    pub active_tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "Settings::default_always_on_top")]
    pub always_on_top: bool,
    #[serde(default = "Settings::default_opacity_active")]
    pub opacity_active: f64,
    #[serde(default = "Settings::default_opacity_inactive")]
    pub opacity_inactive: f64,
    #[serde(default = "Settings::default_sound_enabled")]
    pub sound_enabled: bool,
}

impl Settings {
    pub const DEFAULT_ALWAYS_ON_TOP: bool = true;
    pub const DEFAULT_OPACITY_ACTIVE: f64 = 1.0;
    pub const DEFAULT_OPACITY_INACTIVE: f64 = 0.3;
    pub const DEFAULT_SOUND_ENABLED: bool = true;

    fn default_always_on_top() -> bool {
        Self::DEFAULT_ALWAYS_ON_TOP
    }

    fn default_opacity_active() -> f64 {
        Self::DEFAULT_OPACITY_ACTIVE
    }

    fn default_opacity_inactive() -> f64 {
        Self::DEFAULT_OPACITY_INACTIVE
    }

    fn default_sound_enabled() -> bool {
        Self::DEFAULT_SOUND_ENABLED
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            always_on_top: Self::DEFAULT_ALWAYS_ON_TOP,
            opacity_active: Self::DEFAULT_OPACITY_ACTIVE,
            opacity_inactive: Self::DEFAULT_OPACITY_INACTIVE,
            sound_enabled: Self::DEFAULT_SOUND_ENABLED,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CachedPaths {
    #[serde(default)]
    pub npx_path: String,
    #[serde(default)]
    pub tmux_path: String,
}

impl CachedPaths {
    pub fn update_from_event(&mut self, event: &EventInfo) {
        if !event.npx_path.is_empty() {
            self.npx_path = event.npx_path.clone();
        }
        if !event.tmux_path.is_empty() {
            self.tmux_path = event.tmux_path.clone();
        }
    }
}

#[derive(Default, Clone)]
pub struct AppState {
    pub sessions: HashMap<String, SessionInfo>,
    pub recent_events: VecDeque<EventInfo>,
    pub settings: Settings,
    pub cached_paths: CachedPaths,
    pub notes: String,
    pub memo_tabs: Vec<MemoTab>,
    pub active_tab_id: String,
}

impl AppState {
    pub fn waiting_session_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|s| {
                s.status == SessionStatus::WaitingPermission
                    || s.status == SessionStatus::WaitingInput
            })
            .count()
    }

    pub fn to_dashboard_data(&self) -> DashboardData {
        // Sort sessions by last_event timestamp in descending order (newest first)
        // Empty timestamps are sorted to the end
        let mut sessions: Vec<SessionInfo> = self.sessions.values().cloned().collect();
        sessions.sort_by(|a, b| {
            match (a.last_event.is_empty(), b.last_event.is_empty()) {
                (true, true) => std::cmp::Ordering::Equal,
                (true, false) => std::cmp::Ordering::Greater, // Empty goes to end
                (false, true) => std::cmp::Ordering::Less,    // Non-empty comes first
                (false, false) => b.last_event.cmp(&a.last_event), // Descending order
            }
        });

        DashboardData {
            sessions,
            events: self.recent_events.iter().cloned().collect(),
            notes: self.notes.clone(),
            memo_tabs: self.memo_tabs.clone(),
            active_tab_id: self.active_tab_id.clone(),
        }
    }

    /// Insert or update a session with the given status and waiting_for info
    pub fn upsert_session(
        &mut self,
        key: String,
        event: &EventInfo,
        status: SessionStatus,
        waiting_for: String,
    ) {
        self.sessions
            .entry(key)
            .and_modify(|s| {
                s.status = status.clone();
                s.last_event = event.timestamp.clone();
                s.waiting_for = waiting_for.clone();
                if !event.tmux_pane.is_empty() {
                    s.tmux_pane = event.tmux_pane.clone();
                }
                // Update custom_name from env var if provided and not already set by UI
                if !event.custom_name.is_empty() && s.custom_name.is_empty() {
                    s.custom_name = event.custom_name.clone();
                }
            })
            .or_insert_with(|| SessionInfo {
                session_id: event.session_id.clone(),
                project_name: event.project_name.clone(),
                project_dir: event.project_dir.clone(),
                status,
                last_event: event.timestamp.clone(),
                waiting_for,
                tmux_pane: event.tmux_pane.clone(),
                custom_name: event.custom_name.clone(),
                priority: Priority::default(),
            });
    }

    /// Rename a session's custom name
    pub fn rename_session(&mut self, key: &str, new_name: String) -> bool {
        if let Some(session) = self.sessions.get_mut(key) {
            session.custom_name = new_name;
            true
        } else {
            false
        }
    }

    /// Set a session's priority
    pub fn set_priority(&mut self, key: &str, priority: Priority) -> bool {
        if let Some(session) = self.sessions.get_mut(key) {
            session.priority = priority;
            true
        } else {
            false
        }
    }
}

pub struct ManagedState(pub Arc<Mutex<AppState>>);
