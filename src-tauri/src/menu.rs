use tauri::{
    menu::{
        AboutMetadata, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
        PredefinedMenuItem, Submenu, SubmenuBuilder,
    },
    Runtime,
};

use crate::state::{
    AppState, EventInfo, EventType, NotificationType, SessionInfo, SessionStatus, Settings,
};

/// Get emoji for event type
fn get_event_emoji(event: &EventInfo) -> &'static str {
    match &event.event_type {
        EventType::Notification => match &event.notification_type {
            NotificationType::PermissionPrompt => "🔐",
            NotificationType::IdlePrompt => "⏳",
            NotificationType::Other => "🔔",
        },
        EventType::Stop => "✅",
        EventType::SessionStart => "🚀",
        EventType::SessionEnd => "🏁",
        EventType::PostToolUse => "🔧",
        EventType::UserPromptSubmit => "💬",
        EventType::Unknown => "📌",
    }
}

/// Get display name for event type
fn get_event_name(event_type: &EventType) -> &'static str {
    match event_type {
        EventType::SessionStart => "session_start",
        EventType::SessionEnd => "session_end",
        EventType::Notification => "notification",
        EventType::Stop => "stop",
        EventType::PostToolUse => "post_tool_use",
        EventType::UserPromptSubmit => "user_prompt_submit",
        EventType::Unknown => "unknown",
    }
}

/// Parse opacity menu ID and return (is_active, opacity_value) if valid
/// Menu ID format: "opacity_{inactive|active}_{10|30|50|70|80|90|100}"
pub fn parse_opacity_menu_id(menu_id: &str) -> Option<(bool, f64)> {
    let suffix = menu_id.strip_prefix("opacity_")?;
    let (target, value_str) = suffix.rsplit_once('_')?;
    let value: i32 = value_str.parse().ok()?;
    let opacity = value as f64 / 100.0;

    match target {
        "active" => Some((true, opacity)),
        "inactive" => Some((false, opacity)),
        _ => None,
    }
}

fn build_opacity_submenu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &Settings,
) -> tauri::Result<Submenu<R>> {
    let opacity_inactive_label =
        format!("Inactive: {}%", (settings.opacity_inactive * 100.0) as i32);
    let opacity_active_label = format!("Active: {}%", (settings.opacity_active * 100.0) as i32);

    SubmenuBuilder::new(app, "Opacity")
        .item(
            &MenuItemBuilder::with_id("opacity_inactive_header", &opacity_inactive_label)
                .enabled(false)
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("opacity_inactive_10", "  10%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_inactive_30", "  30%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_inactive_50", "  50%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_inactive_70", "  70%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_inactive_100", "  100%").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("opacity_active_header", &opacity_active_label)
                .enabled(false)
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("opacity_active_70", "  70%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_active_80", "  80%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_active_90", "  90%").build(app)?)
        .item(&MenuItemBuilder::with_id("opacity_active_100", "  100%").build(app)?)
        .build()
}

fn build_help_events_submenu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    events: &std::collections::VecDeque<EventInfo>,
) -> tauri::Result<Submenu<R>> {
    let mut submenu_builder = SubmenuBuilder::new(app, "Recent Events");

    if events.is_empty() {
        let empty_item = MenuItemBuilder::with_id("help_events_empty", "No recent events")
            .enabled(false)
            .build(app)?;
        submenu_builder = submenu_builder.item(&empty_item);
    } else {
        for (idx, event) in events.iter().rev().take(10).enumerate() {
            let emoji = get_event_emoji(event);
            let event_name = get_event_name(&event.event_type);
            // Format timestamp for display (extract time portion)
            let time_str = event
                .timestamp
                .split('T')
                .nth(1)
                .map(|t| t.split('.').next().unwrap_or(t))
                .unwrap_or(&event.timestamp);
            let title = format!(
                "{} {} {} ({})",
                emoji, event.project_name, event_name, time_str
            );
            let item = MenuItemBuilder::with_id(format!("help_event_{}", idx), &title)
                .enabled(false)
                .build(app)?;
            submenu_builder = submenu_builder.item(&item);
        }
    }

    submenu_builder.build()
}

/// Build the application menu bar
///
/// Structure:
/// - Eyes on Claude Code: About, Quit
/// - Edit: Undo, Redo, Cut, Copy, Paste, Find
/// - Window: Close, Open Dashboard, Always on Top, Opacity, Sound
/// - Help: Open Log Directory, Recent Events
pub fn build_app_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> tauri::Result<Menu<R>> {
    // Eyes on Claude Code menu (app menu)
    let version = app.config().version.clone();
    let clear_all_sessions =
        MenuItemBuilder::with_id("clear_sessions", "Clear All Sessions").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Eyes on Claude Code")
        .about(Some(AboutMetadata {
            name: Some("Eyes on Claude Code".to_string()),
            version,
            ..Default::default()
        }))
        .separator()
        .item(&clear_all_sessions)
        .separator()
        .quit()
        .build()?;

    // Edit menu (standard editing commands)
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .build()?;

    // Window menu
    let close_window = PredefinedMenuItem::close_window(app, Some("Close Window"))?;

    let open_dashboard = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;

    let always_on_top = CheckMenuItemBuilder::with_id("always_on_top", "Always on Top")
        .checked(state.settings.always_on_top)
        .accelerator("CmdOrCtrl+T")
        .build(app)?;

    let opacity_submenu = build_opacity_submenu(app, &state.settings)?;

    let sound_enabled = CheckMenuItemBuilder::with_id("sound_enabled", "Sound")
        .checked(state.settings.sound_enabled)
        .build(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&close_window)
        .separator()
        .item(&open_dashboard)
        .separator()
        .item(&always_on_top)
        .item(&opacity_submenu)
        .item(&sound_enabled)
        .build()?;

    // Help menu
    let open_logs = MenuItemBuilder::with_id("open_logs", "Open Log Directory").build(app)?;
    let events_submenu = build_help_events_submenu(app, &state.recent_events)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&open_logs)
        .separator()
        .item(&events_submenu)
        .build()?;

    // Build the menu bar
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

fn build_session_items<R: Runtime>(
    app: &tauri::AppHandle<R>,
    sessions: &std::collections::HashMap<String, SessionInfo>,
) -> tauri::Result<Vec<MenuItem<R>>> {
    let mut items = Vec::new();

    if !sessions.is_empty() {
        let header = MenuItemBuilder::with_id("sessions_header", "Sessions")
            .enabled(false)
            .build(app)?;
        items.push(header);

        for session in sessions.values() {
            let emoji = session.status.emoji();
            let title = format!("{} {}", emoji, session.project_name);
            let item =
                MenuItemBuilder::with_id(format!("session_{}", session.project_name), &title)
                    .enabled(false)
                    .build(app)?;
            items.push(item);
        }
    }

    Ok(items)
}

fn build_events_submenu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    events: &std::collections::VecDeque<EventInfo>,
) -> tauri::Result<Option<Submenu<R>>> {
    if events.is_empty() {
        return Ok(None);
    }

    let mut submenu_builder = SubmenuBuilder::new(app, "Recent Events");

    for (idx, event) in events.iter().rev().take(10).enumerate() {
        let emoji = get_event_emoji(event);
        let event_name = get_event_name(&event.event_type);
        let title = format!("{} {}: {}", emoji, event.project_name, event_name);
        let item = MenuItemBuilder::with_id(format!("event_{}", idx), &title)
            .enabled(false)
            .build(app)?;
        submenu_builder = submenu_builder.item(&item);
    }

    Ok(Some(submenu_builder.build()?))
}

/// Build the tray menu (shows sessions and events status)
pub fn build_tray_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> tauri::Result<Menu<R>> {
    // Header
    let waiting_count = state
        .sessions
        .values()
        .filter(|s| {
            s.status == SessionStatus::WaitingPermission || s.status == SessionStatus::WaitingInput
        })
        .count();

    let header_text = if waiting_count > 0 {
        format!("⚠️ {} session(s) waiting", waiting_count)
    } else if state.sessions.is_empty() {
        "No active sessions".to_string()
    } else {
        format!("{} active session(s)", state.sessions.len())
    };

    let header = MenuItemBuilder::with_id("header", &header_text)
        .enabled(false)
        .build(app)?;

    // Session items
    let session_items = build_session_items(app, &state.sessions)?;

    // Events submenu
    let events_submenu = build_events_submenu(app, &state.recent_events)?;

    // Footer items
    let open_dashboard = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard").build(app)?;
    let open_logs = MenuItemBuilder::with_id("open_logs", "Open Log Folder").build(app)?;
    let clear_sessions = MenuItemBuilder::with_id("clear_sessions", "Clear Sessions").build(app)?;

    // Build menu
    let menu = Menu::with_items(app, &[&header, &PredefinedMenuItem::separator(app)?])?;

    for item in &session_items {
        menu.append(item)?;
    }

    if !session_items.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    if let Some(submenu) = &events_submenu {
        menu.append(submenu)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&open_dashboard)?;
    menu.append(&open_logs)?;
    menu.append(&clear_sessions)?;

    Ok(menu)
}
