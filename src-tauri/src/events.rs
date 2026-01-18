use std::fs::File;
use std::io::{BufRead, BufReader};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::settings::get_events_file;
use crate::state::{AppState, EventInfo, EventType, NotificationType, Priority, SessionInfo, SessionStatus};
use crate::tmux::set_cached_tmux_path;

pub fn process_event(state: &mut AppState, event: EventInfo) {
    state.recent_events.push_back(event.clone());
    if state.recent_events.len() > 50 {
        state.recent_events.pop_front();
    }

    let project_key = if event.project_dir.is_empty() {
        event.project_name.clone()
    } else {
        event.project_dir.clone()
    };
    let key = if event.tmux_pane.is_empty() {
        project_key
    } else {
        format!("{}:{}", project_key, event.tmux_pane)
    };

    match event.event_type {
        EventType::SessionStart => {
            state.cached_paths.update_from_event(&event);
            set_cached_tmux_path(&event.tmux_path);
            state.sessions.insert(
                key,
                SessionInfo {
                    session_id: event.session_id.clone(),
                    project_name: event.project_name.clone(),
                    project_dir: event.project_dir.clone(),
                    status: SessionStatus::Active,
                    last_event: event.timestamp.clone(),
                    waiting_for: String::new(),
                    tmux_pane: event.tmux_pane,
                    custom_name: event.custom_name.clone(),
                    priority: Priority::default(),
                },
            );
        }
        EventType::SessionEnd => {
            state.sessions.remove(&key);
        }
        EventType::Notification => {
            let new_status = match event.notification_type {
                NotificationType::PermissionPrompt => SessionStatus::WaitingPermission,
                NotificationType::IdlePrompt => SessionStatus::WaitingInput,
                NotificationType::Other => SessionStatus::Active,
            };
            let waiting_info = if !event.message.is_empty() {
                event.message.clone()
            } else if !event.tool_name.is_empty() {
                event.tool_name.clone()
            } else {
                String::new()
            };
            state.upsert_session(key, &event, new_status, waiting_info);
        }
        EventType::Stop => {
            state.cached_paths.update_from_event(&event);
            set_cached_tmux_path(&event.tmux_path);
            state.upsert_session(key, &event, SessionStatus::Completed, String::new());
        }
        EventType::PostToolUse => {
            state.upsert_session(key, &event, SessionStatus::Active, String::new());
        }
        EventType::UserPromptSubmit => {
            // User submitted a prompt - Claude is now actively working
            state.upsert_session(key, &event, SessionStatus::Active, String::new());
        }
        EventType::Unknown => {
            if let Some(session) = state.sessions.get_mut(&key) {
                session.last_event = event.timestamp;
            }
        }
    }
}

/// Drain (consume) `events.jsonl` as a queue:
/// - atomically rename `events.jsonl` to a processing file
/// - recreate an empty `events.jsonl`
/// - process each line (JSON) and append the raw JSON to the app log
/// - delete the processing file
///
/// Parse-failed lines are logged as error and dropped.
pub fn drain_events_queue(app: &tauri::AppHandle, state: &mut AppState) -> Vec<EventInfo> {
    let mut new_events = Vec::new();

    let events_file = match get_events_file(app) {
        Ok(path) => path,
        Err(e) => {
            log::error!(target: "eocc.events", "Cannot determine events file path: {}", e);
            return new_events;
        }
    };

    if !events_file.exists() {
        return new_events;
    }

    let file_size = match std::fs::metadata(&events_file).map(|m| m.len()) {
        Ok(size) => size,
        Err(_) => return new_events,
    };
    if file_size == 0 {
        return new_events;
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    let processing_path =
        events_file.with_file_name(format!("events.processing.{}.{}.jsonl", ts, pid));

    // Atomically move the queue file out of the way so the hook can keep appending to a fresh file.
    if let Err(e) = std::fs::rename(&events_file, &processing_path) {
        // If the hook is writing concurrently, retry later (best-effort).
        log::warn!(
            target: "eocc.events",
            "Failed to rename events.jsonl for draining (will retry later): {:?}",
            e
        );
        return new_events;
    }

    // Recreate empty events.jsonl (best-effort).
    if let Err(e) = std::fs::write(&events_file, "") {
        log::error!(
            target: "eocc.events",
            "Failed to recreate empty events.jsonl: {:?}",
            e
        );
    }

    // Process the rotated file.
    match File::open(&processing_path) {
        Ok(file) => {
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<EventInfo>(&line) {
                    Ok(event) => {
                        process_event(state, event.clone());
                        new_events.push(event);
                        // Store raw event JSON in the app log (rotated by tauri-plugin-log).
                        log::info!(target: "eocc.events.raw", "{}", line);
                    }
                    Err(err) => {
                        log::error!(
                            target: "eocc.events.parse",
                            "Failed to parse event jsonl line (dropped): err={} line={}",
                            err,
                            line
                        );
                    }
                }
            }
        }
        Err(e) => {
            log::error!(
                target: "eocc.events",
                "Failed to open processing events file {:?}: {:?}",
                processing_path,
                e
            );
        }
    }

    // Delete consumed file.
    if let Err(e) = std::fs::remove_file(&processing_path) {
        log::error!(
            target: "eocc.events",
            "Failed to delete processing events file {:?}: {:?}",
            processing_path,
            e
        );
    }

    new_events
}
