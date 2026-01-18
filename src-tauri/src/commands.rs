use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::constants::{MINI_VIEW_HEIGHT, MINI_VIEW_WIDTH, SETUP_MODAL_HEIGHT, SETUP_MODAL_WIDTH};
use crate::difit::{
    calculate_diff_hash, get_diff_content, start_difit_server_with_content, DiffType,
    DifitProcessRegistry, HashCompareResult,
};
use crate::git::{get_git_info, GitInfo};
use crate::persist::save_runtime_state;
use crate::settings::save_settings;
use crate::setup::{self, SetupStatus};
use crate::state::{DashboardData, ManagedState, Priority, Settings};
use crate::tmux::{self, TmuxCursorPosition, TmuxPane, TmuxPaneSize};
use crate::tray::{emit_state_update, update_tray_and_badge};

const LOCK_ERROR: &str = "Failed to acquire state lock";

#[tauri::command]
pub fn get_dashboard_data(state: tauri::State<'_, ManagedState>) -> Result<DashboardData, String> {
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    Ok(state_guard.to_dashboard_data())
}

#[tauri::command]
pub fn remove_session(
    session_key: String,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.sessions.remove(&session_key);
    update_tray_and_badge(&app, &state_guard);
    emit_state_update(&app, &state_guard);
    save_runtime_state(&app, &state_guard);
    Ok(())
}

#[tauri::command]
pub fn clear_all_sessions(
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.sessions.clear();
    update_tray_and_badge(&app, &state_guard);
    emit_state_update(&app, &state_guard);
    save_runtime_state(&app, &state_guard);
    Ok(())
}

#[tauri::command]
pub fn rename_session(
    session_key: String,
    new_name: String,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;

    // Get tmux_pane before renaming in state
    let tmux_pane = state_guard
        .sessions
        .get(&session_key)
        .map(|s| s.tmux_pane.clone());

    if state_guard.rename_session(&session_key, new_name.clone()) {
        // Also rename the tmux session if tmux_pane is available
        if let Some(pane_id) = tmux_pane {
            if !pane_id.is_empty() {
                if let Err(e) = tmux::rename_session(&pane_id, &new_name) {
                    log::warn!(target: "eocc.commands", "Failed to rename tmux session: {}", e);
                }
            }
        }

        update_tray_and_badge(&app, &state_guard);
        emit_state_update(&app, &state_guard);
        save_runtime_state(&app, &state_guard);
        Ok(())
    } else {
        Err(format!("Session not found: {}", session_key))
    }
}

#[tauri::command]
pub fn save_notes(
    notes: String,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.notes = notes;
    save_runtime_state(&app, &state_guard);
    Ok(())
}

#[tauri::command]
pub fn set_session_priority(
    session_key: String,
    priority: Priority,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    if state_guard.set_priority(&session_key, priority) {
        emit_state_update(&app, &state_guard);
        save_runtime_state(&app, &state_guard);
        Ok(())
    } else {
        Err(format!("Session not found: {}", session_key))
    }
}

#[tauri::command]
pub fn get_always_on_top(state: tauri::State<'_, ManagedState>) -> Result<bool, String> {
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    Ok(state_guard.settings.always_on_top)
}

#[tauri::command]
pub fn set_always_on_top(
    enabled: bool,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.settings.always_on_top = enabled;
    save_settings(&app, &state_guard.settings);

    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.set_always_on_top(enabled);
    }

    update_tray_and_badge(&app, &state_guard);
    Ok(())
}

/// Set window size for setup modal (enlarged) or normal miniview
#[tauri::command]
pub fn set_window_size_for_setup(enlarged: bool, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("dashboard") {
        if enlarged {
            let _ = window.set_decorations(true);
            let _ = window.set_size(tauri::LogicalSize::new(
                SETUP_MODAL_WIDTH,
                SETUP_MODAL_HEIGHT,
            ));
            let _ = window.center();
        } else {
            let _ = window.set_decorations(false);
            let _ = window.set_size(tauri::LogicalSize::new(MINI_VIEW_WIDTH, MINI_VIEW_HEIGHT));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, ManagedState>) -> Result<Settings, String> {
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    Ok(state_guard.settings.clone())
}

#[tauri::command]
pub fn set_opacity_active(
    opacity: f64,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.settings.opacity_active = opacity.clamp(0.1, 1.0);
    save_settings(&app, &state_guard.settings);
    Ok(())
}

#[tauri::command]
pub fn set_opacity_inactive(
    opacity: f64,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    state_guard.settings.opacity_inactive = opacity.clamp(0.1, 1.0);
    save_settings(&app, &state_guard.settings);
    Ok(())
}

#[tauri::command]
pub fn get_repo_git_info(project_dir: String) -> GitInfo {
    get_git_info(&project_dir)
}

/// Generate a unique window label for a diff based on project and type
fn generate_diff_window_label(project_dir: &str, diff_type: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    project_dir.hash(&mut hasher);
    diff_type.hash(&mut hasher);
    format!("difit-{:x}", hasher.finish())
}

/// Loading page HTML for diff window
const LOADING_HTML: &str = r#"
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: #1a1a2e;
            color: #eee;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .loader {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid #333;
            border-top-color: #6c5ce7;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <div>Loading diff...</div>
    </div>
</body>
</html>
"#;

#[tauri::command]
pub fn open_diff(
    project_dir: String,
    diff_type: String,
    base_branch: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedState>,
    difit_registry: tauri::State<'_, Arc<DifitProcessRegistry>>,
) -> Result<(), String> {
    // Validate project directory
    let path = Path::new(&project_dir);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", project_dir));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", project_dir));
    }
    // Check if it's a git repository
    if !path.join(".git").exists() {
        return Err(format!("Not a git repository: {}", project_dir));
    }

    // Generate unique window label based on project and diff type
    let window_label = generate_diff_window_label(&project_dir, &diff_type);

    let diff = match diff_type.as_str() {
        "unstaged" => DiffType::Unstaged,
        "staged" => DiffType::Staged,
        "commit" => DiffType::LatestCommit,
        "branch" => DiffType::Branch,
        _ => return Err(format!("Unknown diff type: {}", diff_type)),
    };

    // Get cached npx path from state
    let npx_path = {
        let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        let path = state_guard.cached_paths.npx_path.clone();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    };

    // Create loading page data URL
    let loading_url = format!(
        "data:text/html;base64,{}",
        base64_encode(LOADING_HTML.as_bytes())
    );

    // Check if window already exists
    if let Some(existing_window) = app.get_webview_window(&window_label) {
        // Get current diff content and calculate hash
        let diff_content = match get_diff_content(&project_dir, diff, base_branch.as_deref()) {
            Ok(content) => content,
            Err(e) => {
                // Show error in existing window (consistent with new window behavior)
                let _ = existing_window.show();
                let _ = existing_window.set_focus();
                show_error_in_window(&existing_window, &e, &diff_type);
                return Ok(());
            }
        };
        let new_hash = calculate_diff_hash(&diff_content);

        // Atomically check if diff has changed and update hash
        let compare_result = difit_registry.compare_and_update_hash(&window_label, new_hash);
        if compare_result == HashCompareResult::Unchanged {
            // No changes, just focus the window
            let _ = existing_window.show();
            let _ = existing_window.set_focus();
            return Ok(());
        }

        // Diff has changed (process already killed by compare_and_update_hash)
        // Show loading page
        let _ = existing_window.set_title(&format!("Diff - {} (Loading...)", diff_type));
        if let Ok(url) = loading_url.parse() {
            let _ = existing_window.navigate(url);
        }
        let _ = existing_window.show();
        let _ = existing_window.set_focus();

        // Get port only when needed
        let port = difit_registry.get_next_port();

        // Start new difit server in background thread
        let ctx = DifitSpawnContext {
            app_handle: app.app_handle().clone(),
            registry: Arc::clone(&difit_registry),
            window_label,
            project_dir,
            diff_type_display: diff_type,
            port,
            npx_path,
        };
        spawn_difit_server_with_content(ctx, diff_content);

        return Ok(());
    }

    // Get port only when creating new window
    let port = difit_registry.get_next_port();

    // Create window immediately with loading page
    let window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(
            loading_url
                .parse()
                .map_err(|e| format!("Invalid URL: {}", e))?,
        ),
    )
    .title(format!("Diff - {} (Loading...)", diff_type))
    .inner_size(1200.0, 800.0)
    .center()
    .build()
    .map_err(|e| format!("Failed to create diff window: {}", e))?;

    // Set up window close handler
    let registry_clone = Arc::clone(&difit_registry);
    let label_clone = window_label.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            registry_clone.kill(&label_clone);
        }
    });

    // Start difit server in background thread
    let ctx = DifitSpawnContext {
        app_handle: app.app_handle().clone(),
        registry: Arc::clone(&difit_registry),
        window_label,
        project_dir,
        diff_type_display: diff_type,
        port,
        npx_path,
    };
    spawn_difit_server(ctx, diff, base_branch);

    Ok(())
}

fn base64_encode(data: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(data)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

fn show_error_in_window(window: &tauri::WebviewWindow, error: &str, diff_type: &str) {
    let error_html = format!(
        r#"data:text/html;base64,{}"#,
        base64_encode(
            format!(
                r#"<!DOCTYPE html><html><head><style>
                body {{ margin: 0; display: flex; justify-content: center; align-items: center;
                height: 100vh; background: #1a1a2e; color: #e74c3c;
                font-family: -apple-system, BlinkMacSystemFont, sans-serif; }}
                .error {{ text-align: center; padding: 20px; }}
                </style></head><body><div class="error">
                <h2>Failed to load diff</h2><p>{}</p>
                </div></body></html>"#,
                html_escape(error)
            )
            .as_bytes()
        )
    );
    if let Ok(url) = error_html.parse() {
        let _ = window.navigate(url);
        let _ = window.set_title(&format!("Diff - {} (Error)", diff_type));
    }
}

struct DifitSpawnContext {
    app_handle: tauri::AppHandle,
    registry: Arc<DifitProcessRegistry>,
    window_label: String,
    project_dir: String,
    diff_type_display: String,
    port: u16,
    npx_path: Option<String>,
}

impl DifitSpawnContext {
    fn handle_server_result(&self, result: Result<crate::difit::DifitServerInfo, String>) {
        match result {
            Ok(server_info) => {
                self.registry
                    .register(self.window_label.clone(), server_info.process);
                if let Some(window) = self.app_handle.get_webview_window(&self.window_label) {
                    if let Ok(url) = server_info.url.parse() {
                        let _ = window.navigate(url);
                        let _ = window.set_title(&format!("Diff - {}", self.diff_type_display));
                    }
                } else {
                    log::warn!(target: "eocc.difit", "handle_server_result: window not found for label={}", self.window_label);
                }
            }
            Err(e) => {
                log::error!(target: "eocc.difit", "handle_server_result: error={}", e);
                if let Some(window) = self.app_handle.get_webview_window(&self.window_label) {
                    show_error_in_window(&window, &e, &self.diff_type_display);
                }
            }
        }
    }
}

fn spawn_difit_server(ctx: DifitSpawnContext, diff: DiffType, base_branch: Option<String>) {
    std::thread::spawn(move || {
        match get_diff_content(&ctx.project_dir, diff, base_branch.as_deref()) {
            Ok(diff_content) => {
                let hash = calculate_diff_hash(&diff_content);
                ctx.registry.set_diff_hash(&ctx.window_label, hash);

                let result = start_difit_server_with_content(
                    diff_content,
                    &ctx.project_dir,
                    ctx.port,
                    ctx.npx_path.as_deref(),
                );
                ctx.handle_server_result(result);
            }
            Err(e) => {
                log::error!(target: "eocc.difit", "get_diff_content failed: {}", e);
                if let Some(window) = ctx.app_handle.get_webview_window(&ctx.window_label) {
                    show_error_in_window(&window, &e, &ctx.diff_type_display);
                }
            }
        }
    });
}

fn spawn_difit_server_with_content(ctx: DifitSpawnContext, diff_content: Vec<u8>) {
    std::thread::spawn(move || {
        let result = start_difit_server_with_content(
            diff_content,
            &ctx.project_dir,
            ctx.port,
            ctx.npx_path.as_deref(),
        );
        ctx.handle_server_result(result);
    });
}

// ============================================================================
// Setup commands
// ============================================================================

/// Get the current setup status
#[tauri::command]
pub fn get_setup_status(app: tauri::AppHandle) -> SetupStatus {
    setup::get_setup_status(&app)
}

/// Install the hook script to app data directory
#[tauri::command]
pub fn install_hook(app: tauri::AppHandle) -> Result<String, String> {
    let path = setup::install_hook_script(&app)?;
    Ok(path.to_string_lossy().to_string())
}

/// Check Claude settings and return merged settings if needed
#[tauri::command]
pub fn check_claude_settings(app: tauri::AppHandle) -> Result<SetupStatus, String> {
    // Ensure hook is installed first
    if !setup::is_hook_installed(&app) {
        setup::install_hook_script(&app)?;
    }
    Ok(setup::get_setup_status(&app))
}

/// Open the Claude settings.json file in the default editor
#[tauri::command]
pub fn open_claude_settings() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Failed to get home directory")?;
    let claude_dir = home.join(".claude");
    let settings_path = claude_dir.join("settings.json");

    // Create directory and file if they don't exist
    if !settings_path.exists() {
        std::fs::create_dir_all(&claude_dir)
            .map_err(|e| format!("Failed to create .claude directory: {:?}", e))?;
        std::fs::write(&settings_path, "{}\n")
            .map_err(|e| format!("Failed to create settings.json: {:?}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&settings_path)
            .spawn()
            .map_err(|e| format!("Failed to open settings: {:?}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&settings_path)
            .spawn()
            .map_err(|e| format!("Failed to open settings: {:?}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &settings_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open settings: {:?}", e))?;
    }

    Ok(())
}

// ============================================================================
// Tmux commands
// ============================================================================

#[tauri::command]
pub fn open_tmux_viewer(pane_id: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    pane_id.hash(&mut hasher);
    let window_label = format!("tmux-viewer-{:x}", hasher.finish());

    // Check if window already exists - if so, focus it and return
    if let Some(existing_window) = app.get_webview_window(&window_label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        return Ok(());
    }

    let url = format!("index.html?tmux_pane={}", urlencoding::encode(&pane_id));

    WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App(url.into()))
        .title(format!("tmux - {}", pane_id))
        .inner_size(1200.0, 800.0)
        .center()
        .transparent(true)
        .decorations(true)
        .build()
        .map_err(|e| format!("Failed to create tmux viewer window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn tmux_is_available() -> bool {
    tmux::is_tmux_available()
}

#[tauri::command]
pub fn tmux_list_panes() -> Result<Vec<TmuxPane>, String> {
    tmux::list_panes()
}

#[tauri::command]
pub fn tmux_capture_pane(pane_id: String) -> Result<String, String> {
    tmux::capture_pane(&pane_id)
}

#[tauri::command]
pub fn tmux_send_keys(pane_id: String, keys: String) -> Result<(), String> {
    tmux::send_keys(&pane_id, &keys)
}

#[tauri::command]
pub fn tmux_get_pane_size(pane_id: String) -> Result<TmuxPaneSize, String> {
    tmux::get_pane_size(&pane_id)
}

#[tauri::command]
pub fn tmux_get_cursor_position(pane_id: String) -> Result<TmuxCursorPosition, String> {
    tmux::get_cursor_position(&pane_id)
}
