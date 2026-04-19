use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::constants::{MINI_VIEW_HEIGHT, MINI_VIEW_WIDTH, SETUP_MODAL_HEIGHT, SETUP_MODAL_WIDTH};
use crate::difit::{
    calculate_diff_hash, get_diff_content, start_difit_server, DiffType, DifitProcessRegistry,
    ProcessAction,
};
use crate::git::{get_branches, get_git_info, GitInfo};
use crate::persist::save_runtime_state;
use crate::settings::save_settings;
use crate::setup::{self, SetupStatus};
use crate::state::{DashboardData, ManagedState, Settings};
use crate::tmux::{self, TmuxPane, TmuxPaneSize};
use crate::tray::{emit_state_update, update_tray_and_badge};

const LOCK_ERROR: &str = "Failed to acquire state lock";

fn log_slow_lock(label: &str, elapsed: std::time::Duration) {
    if elapsed > std::time::Duration::from_millis(10) {
        log::warn!(target: "eocc.perf", "{}: slow lock {:?}", label, elapsed);
    }
}

fn log_slow_op(label: &str, elapsed: std::time::Duration) {
    if elapsed > std::time::Duration::from_millis(100) {
        log::warn!(target: "eocc.perf", "{}: {:?}", label, elapsed);
    }
}

#[tauri::command]
pub fn get_dashboard_data(state: tauri::State<'_, ManagedState>) -> Result<DashboardData, String> {
    let start = std::time::Instant::now();
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    log_slow_lock("get_dashboard_data", start.elapsed());
    let result = Ok(state_guard.to_dashboard_data());
    log_slow_op("get_dashboard_data", start.elapsed());
    result
}

#[tauri::command]
pub fn remove_session(
    project_dir: String,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let lock_start = std::time::Instant::now();
    let state_clone = {
        let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        log_slow_lock("remove_session", lock_start.elapsed());
        state_guard.sessions.remove(&project_dir);
        state_guard.clone()
    };
    update_tray_and_badge(&app, &state_clone);
    emit_state_update(&app, &state_clone);
    save_runtime_state(&app, &state_clone);
    log_slow_op("remove_session", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn clear_all_sessions(
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let lock_start = std::time::Instant::now();
    let state_clone = {
        let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        log_slow_lock("clear_all_sessions", lock_start.elapsed());
        state_guard.sessions.clear();
        state_guard.clone()
    };
    update_tray_and_badge(&app, &state_clone);
    emit_state_update(&app, &state_clone);
    save_runtime_state(&app, &state_clone);
    log_slow_op("clear_all_sessions", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn get_always_on_top(state: tauri::State<'_, ManagedState>) -> Result<bool, String> {
    let start = std::time::Instant::now();
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    log_slow_lock("get_always_on_top", start.elapsed());
    Ok(state_guard.settings.always_on_top)
}

#[tauri::command]
pub fn set_always_on_top(
    enabled: bool,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let lock_start = std::time::Instant::now();
    let state_clone = {
        let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        log_slow_lock("set_always_on_top", lock_start.elapsed());
        state_guard.settings.always_on_top = enabled;
        state_guard.clone()
    };
    save_settings(&app, &state_clone.settings);

    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.set_always_on_top(enabled);
    }

    update_tray_and_badge(&app, &state_clone);
    log_slow_op("set_always_on_top", start.elapsed());
    Ok(())
}

/// Set window size for setup modal (enlarged) or normal miniview
#[tauri::command]
pub fn set_window_size_for_setup(enlarged: bool, app: tauri::AppHandle) -> Result<(), String> {
    let start = std::time::Instant::now();
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
    log_slow_op("set_window_size_for_setup", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, ManagedState>) -> Result<Settings, String> {
    let start = std::time::Instant::now();
    let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    log_slow_lock("get_settings", start.elapsed());
    Ok(state_guard.settings.clone())
}

#[tauri::command]
pub fn set_opacity_active(
    opacity: f64,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    log_slow_lock("set_opacity_active", start.elapsed());
    state_guard.settings.opacity_active = opacity.clamp(0.1, 1.0);
    save_settings(&app, &state_guard.settings);
    log_slow_op("set_opacity_active", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn set_opacity_inactive(
    opacity: f64,
    state: tauri::State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
    log_slow_lock("set_opacity_inactive", start.elapsed());
    state_guard.settings.opacity_inactive = opacity.clamp(0.1, 1.0);
    save_settings(&app, &state_guard.settings);
    log_slow_op("set_opacity_inactive", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn get_repo_git_info(project_dir: String) -> GitInfo {
    let start = std::time::Instant::now();
    let result = get_git_info(&project_dir);
    log_slow_op("get_repo_git_info", start.elapsed());
    result
}

#[tauri::command]
pub fn get_repo_branches(project_dir: String) -> Vec<String> {
    let start = std::time::Instant::now();
    let result = get_branches(&project_dir);
    log_slow_op("get_repo_branches", start.elapsed());
    result
}

fn generate_diff_key(project_dir: &str, diff_type: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    project_dir.hash(&mut hasher);
    diff_type.hash(&mut hasher);
    format!("difit-{:x}", hasher.finish())
}

#[tauri::command]
pub fn open_diff(
    project_dir: String,
    diff_type: String,
    base_branch: Option<String>,
    state: tauri::State<'_, ManagedState>,
    difit_registry: tauri::State<'_, Arc<DifitProcessRegistry>>,
) -> Result<(), String> {
    let start = std::time::Instant::now();

    let path = Path::new(&project_dir);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", project_dir));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", project_dir));
    }
    if !path.join(".git").exists() {
        return Err(format!("Not a git repository: {}", project_dir));
    }

    let diff = match diff_type.as_str() {
        "unstaged" => DiffType::Unstaged,
        "staged" => DiffType::Staged,
        "commit" => DiffType::LatestCommit,
        "branch" => DiffType::Branch,
        _ => return Err(format!("Unknown diff type: {}", diff_type)),
    };

    let key = generate_diff_key(&project_dir, &diff_type);

    let diff_content = get_diff_content(&project_dir, diff, base_branch.as_deref())?;
    let hash = calculate_diff_hash(&diff_content);

    let action = difit_registry.check_and_update(&key, hash);
    if action == ProcessAction::SkipUnchanged {
        log::info!(target: "eocc.difit", "Diff unchanged, skipping (key={})", key);
        log_slow_op("open_diff(unchanged)", start.elapsed());
        return Ok(());
    }

    let npx_path = {
        let lock_start = std::time::Instant::now();
        let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        log_slow_lock("open_diff", lock_start.elapsed());
        let path = state_guard.cached_paths.npx_path.clone();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    };

    let process = start_difit_server(diff_content, &project_dir, npx_path.as_deref())?;
    difit_registry.register(key, process);

    log_slow_op("open_diff", start.elapsed());
    Ok(())
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
pub fn open_tmux_viewer(
    pane_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedState>,
) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let start = std::time::Instant::now();

    let always_on_top = {
        let lock_start = std::time::Instant::now();
        let state_guard = state.0.lock().map_err(|_| LOCK_ERROR)?;
        log_slow_lock("open_tmux_viewer", lock_start.elapsed());
        state_guard.settings.always_on_top
    };

    let mut hasher = DefaultHasher::new();
    pane_id.hash(&mut hasher);
    let window_label = format!("tmux-viewer-{:x}", hasher.finish());

    // Check if window already exists - if so, focus it and return
    if let Some(existing_window) = app.get_webview_window(&window_label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        log_slow_op("open_tmux_viewer(existing)", start.elapsed());
        return Ok(());
    }

    let url = format!("index.html?tmux_pane={}", urlencoding::encode(&pane_id));

    WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App(url.into()))
        .title(format!("tmux - {}", pane_id))
        .inner_size(800.0, 600.0)
        .center()
        .transparent(true)
        .decorations(true)
        .always_on_top(always_on_top)
        .build()
        .map_err(|e| format!("Failed to create tmux viewer window: {}", e))?;

    log_slow_op("open_tmux_viewer", start.elapsed());
    Ok(())
}

#[tauri::command]
pub fn tmux_is_available() -> bool {
    tmux::is_tmux_available()
}

#[tauri::command]
pub fn tmux_list_panes() -> Result<Vec<TmuxPane>, String> {
    let start = std::time::Instant::now();
    let result = tmux::list_panes();
    log_slow_op("tmux_list_panes", start.elapsed());
    result
}

#[tauri::command]
pub fn tmux_capture_pane(pane_id: String) -> Result<String, String> {
    let start = std::time::Instant::now();
    let result = tmux::capture_pane(&pane_id);
    log_slow_op("tmux_capture_pane", start.elapsed());
    result
}

#[tauri::command]
pub fn tmux_send_keys(pane_id: String, keys: String) -> Result<(), String> {
    let start = std::time::Instant::now();
    let result = tmux::send_keys(&pane_id, &keys);
    log_slow_op("tmux_send_keys", start.elapsed());
    result
}

#[tauri::command]
pub fn tmux_get_pane_size(pane_id: String) -> Result<TmuxPaneSize, String> {
    let start = std::time::Instant::now();
    let result = tmux::get_pane_size(&pane_id);
    log_slow_op("tmux_get_pane_size", start.elapsed());
    result
}
