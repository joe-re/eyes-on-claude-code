#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod constants;
mod difit;
mod events;
mod git;
mod menu;
mod persist;
mod settings;
mod setup;
mod state;
mod tmux;
mod tray;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::Color,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

use difit::DifitProcessRegistry;
use tauri_plugin_log::RotationStrategy;

use commands::{
    check_claude_settings, clear_all_sessions, get_always_on_top, get_dashboard_data,
    get_repo_git_info, get_settings, get_setup_status, install_hook, open_claude_settings,
    open_diff, open_tmux_viewer, remove_session, rename_session, save_notes, set_always_on_top,
    set_opacity_active, set_opacity_inactive, set_session_priority, set_window_size_for_setup,
    tmux_capture_pane, tmux_get_cursor_position, tmux_get_pane_size, tmux_is_available,
    tmux_list_panes, tmux_send_keys,
};
use constants::{ICON_NORMAL, MINI_VIEW_HEIGHT, MINI_VIEW_WIDTH};
use events::drain_events_queue;
use menu::{build_app_menu, build_tray_menu, parse_opacity_menu_id};
use persist::{load_runtime_state, save_runtime_state};
use settings::{get_app_log_dir, get_log_dir, load_settings, save_settings};
use state::{AppState, ManagedState};
use tray::{emit_state_update, update_tray_and_badge};

fn show_dashboard(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_always_on_top(app: &tauri::AppHandle, state: &mut AppState) {
    state.settings.always_on_top = !state.settings.always_on_top;
    save_settings(app, &state.settings);

    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.set_always_on_top(state.settings.always_on_top);
    }
}

fn create_dashboard_window(
    app: &tauri::App,
    always_on_top: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let transparent_color = Color(0, 0, 0, 0);

    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("index.html".into()))
            .title("Eyes on Claude Code")
            .inner_size(MINI_VIEW_WIDTH, MINI_VIEW_HEIGHT)
            .min_inner_size(200.0, 300.0)
            .center()
            .visible(true)
            .always_on_top(always_on_top)
            .decorations(false)
            .transparent(true)
            .background_color(transparent_color);

    match Image::from_bytes(ICON_NORMAL) {
        Ok(icon) => base_builder.icon(icon)?.build(),
        Err(_) => base_builder.build(),
    }
}

fn start_file_watcher(app_handle: tauri::AppHandle, state: Arc<Mutex<AppState>>) {
    let log_dir = match get_log_dir(&app_handle) {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[eocc] Cannot start file watcher: {}", e);
            return;
        }
    };

    std::thread::spawn(move || {
        if let Err(e) = fs::create_dir_all(&log_dir) {
            eprintln!("[eocc] Failed to create log directory: {:?}", e);
            return;
        }

        let (tx, rx) = std::sync::mpsc::channel();

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[eocc] Failed to create file watcher: {:?}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&log_dir, RecursiveMode::NonRecursive) {
            eprintln!("[eocc] Failed to watch directory: {:?}", e);
            return;
        }

        loop {
            match rx.recv() {
                Ok(_event) => {
                    let Ok(mut state_guard) = state.lock() else {
                        eprintln!("[eocc] Failed to acquire state lock in watcher");
                        continue;
                    };
                    let new_events = drain_events_queue(&app_handle, &mut state_guard);

                    if !new_events.is_empty() {
                        update_tray_and_badge(&app_handle, &state_guard);
                        emit_state_update(&app_handle, &state_guard);
                        save_runtime_state(&app_handle, &state_guard);
                    }
                }
                Err(e) => {
                    eprintln!("[eocc] Watch channel error: {:?}", e);
                    break;
                }
            }
        }
    });
}

fn main() {
    let state = Arc::new(Mutex::new(AppState::default()));
    let difit_registry = Arc::new(DifitProcessRegistry::new());

    let state_clone = Arc::clone(&state);
    let state_for_managed = Arc::clone(&state);
    let difit_registry_clone = Arc::clone(&difit_registry);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .manage(ManagedState(state_for_managed))
        .manage(difit_registry_clone)
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            remove_session,
            rename_session,
            clear_all_sessions,
            save_notes,
            set_session_priority,
            get_always_on_top,
            set_always_on_top,
            get_settings,
            set_opacity_active,
            set_opacity_inactive,
            get_repo_git_info,
            open_diff,
            set_window_size_for_setup,
            // Setup commands
            get_setup_status,
            install_hook,
            check_claude_settings,
            open_claude_settings,
            // Tmux commands
            tmux_is_available,
            tmux_list_panes,
            tmux_capture_pane,
            tmux_send_keys,
            tmux_get_pane_size,
            tmux_get_cursor_position,
            open_tmux_viewer
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let state_for_tray = Arc::clone(&state_clone);

            // Initialize setup (install hook script, create log directory)
            if let Err(e) = setup::initialize_setup(&app_handle) {
                eprintln!("[eocc] Setup initialization failed: {}", e);
                setup::set_init_error(e);
            }

            // Load settings and existing events
            {
                let mut state_guard = state_for_tray.lock().map_err(|_| {
                    tauri::Error::Anyhow(anyhow::anyhow!("Failed to acquire state lock"))
                })?;
                state_guard.settings = load_settings(&app_handle);
                // Restore previous in-memory state snapshot (sessions/recent events/cached paths)
                if let Some(restored) = load_runtime_state(&app_handle) {
                    state_guard.sessions = restored.sessions;
                    state_guard.recent_events = restored.recent_events;
                    state_guard.cached_paths = restored.cached_paths.clone();
                    state_guard.notes = restored.notes;
                    // Also set the cached tmux path in the tmux module
                    tmux::set_cached_tmux_path(&restored.cached_paths.tmux_path);
                }
                // Drain any queued events written by the hook while app was not running
                let new_events = drain_events_queue(&app_handle, &mut state_guard);
                if !new_events.is_empty() {
                    save_runtime_state(&app_handle, &state_guard);
                }
            }

            // Get initial settings
            let always_on_top = {
                let state_guard = state_for_tray.lock().map_err(|_| {
                    tauri::Error::Anyhow(anyhow::anyhow!("Failed to acquire state lock"))
                })?;
                state_guard.settings.always_on_top
            };

            // Create dashboard window
            let dashboard_window = create_dashboard_window(app, always_on_top)?;

            // Set initial badge count
            if let Ok(state_guard) = state_for_tray.lock() {
                let waiting_count = state_guard.waiting_session_count();
                if waiting_count > 0 {
                    let _ = dashboard_window.set_badge_count(Some(waiting_count as i64));
                }
            }

            // Hide dashboard and close all diff windows when close button is clicked
            let app_handle_for_close = app_handle.clone();
            dashboard_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();

                    // Close all diff windows
                    for (label, window) in app_handle_for_close.webview_windows() {
                        if label.starts_with("difit-") {
                            let _ = window.close();
                        }
                    }

                    // Hide dashboard
                    if let Some(window) = app_handle_for_close.get_webview_window("dashboard") {
                        let _ = window.hide();
                    }
                }
            });

            // Build app menu bar
            let state_for_app_menu = Arc::clone(&state_clone);
            let app_menu = {
                let state_guard = state_for_tray.lock().map_err(|_| {
                    tauri::Error::Anyhow(anyhow::anyhow!("Failed to acquire state lock"))
                })?;
                build_app_menu(&app_handle, &state_guard)?
            };

            // Set app menu and handle events
            let app_handle_for_menu = app_handle.clone();
            app.set_menu(app_menu)?;
            app.on_menu_event(move |app, event| {
                let state = &state_for_app_menu;
                match event.id.as_ref() {
                    "open_dashboard" => {
                        show_dashboard(app);
                    }
                    "open_logs" => match get_app_log_dir(&app_handle_for_menu) {
                        Ok(log_dir) => {
                            let _ = opener::open(&log_dir);
                        }
                        Err(e) => eprintln!("[eocc] Cannot open logs: {}", e),
                    },
                    "always_on_top" => match state.lock() {
                        Ok(mut state_guard) => {
                            toggle_always_on_top(app, &mut state_guard);
                            update_tray_and_badge(app, &state_guard);
                        }
                        Err(e) => {
                            eprintln!("[eocc] Failed to acquire lock for always_on_top: {:?}", e)
                        }
                    },
                    "sound_enabled" => match state.lock() {
                        Ok(mut state_guard) => {
                            state_guard.settings.sound_enabled =
                                !state_guard.settings.sound_enabled;
                            save_settings(app, &state_guard.settings);
                            let _ = app.emit("settings-updated", &state_guard.settings);
                            update_tray_and_badge(app, &state_guard);
                        }
                        Err(e) => {
                            eprintln!("[eocc] Failed to acquire lock for sound_enabled: {:?}", e)
                        }
                    },
                    other => {
                        if let Some((is_active, opacity)) = parse_opacity_menu_id(other) {
                            match state.lock() {
                                Ok(mut state_guard) => {
                                    if is_active {
                                        state_guard.settings.opacity_active = opacity;
                                    } else {
                                        state_guard.settings.opacity_inactive = opacity;
                                    }
                                    save_settings(app, &state_guard.settings);
                                    let _ = app.emit("settings-updated", &state_guard.settings);
                                    update_tray_and_badge(app, &state_guard);
                                }
                                Err(e) => {
                                    eprintln!("[eocc] Failed to acquire lock for opacity: {:?}", e)
                                }
                            }
                        }
                    }
                }
            });

            // Build tray menu
            let state_for_tray_clone = Arc::clone(&state_for_tray);
            let app_handle_for_tray = app_handle.clone();
            let tray_menu = {
                let state_guard = state_for_tray.lock().map_err(|_| {
                    tauri::Error::Anyhow(anyhow::anyhow!("Failed to acquire state lock"))
                })?;
                build_tray_menu(&app_handle, &state_guard)?
            };

            let initial_icon = Image::from_bytes(ICON_NORMAL)?;

            // Create tray icon
            let _tray = TrayIconBuilder::with_id("main")
                .icon(initial_icon)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Eyes on Claude Code")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open_dashboard" => {
                        show_dashboard(app);
                    }
                    "open_logs" => match get_app_log_dir(&app_handle_for_tray) {
                        Ok(log_dir) => {
                            let _ = opener::open(&log_dir);
                        }
                        Err(e) => eprintln!("[eocc] Cannot open logs: {}", e),
                    },
                    "clear_sessions" => match state_for_tray_clone.lock() {
                        Ok(mut state_guard) => {
                            state_guard.sessions.clear();
                            update_tray_and_badge(app, &state_guard);
                            emit_state_update(app, &state_guard);
                            save_runtime_state(app, &state_guard);
                        }
                        Err(e) => {
                            eprintln!("[eocc] Failed to acquire lock for clear_sessions: {:?}", e)
                        }
                    },
                    _ => {}
                })
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Menu will show automatically
                    }
                })
                .build(app)?;

            // Start file watcher
            start_file_watcher(app.handle().clone(), Arc::clone(&state_clone));

            Ok(())
        })
        .on_window_event(move |window, event| {
            // Track window focus to update dashboard opacity
            if let tauri::WindowEvent::Focused(focused) = event {
                let label = window.label();
                let app = window.app_handle();

                if label == "dashboard" {
                    // Dashboard focus changed - emit event directly
                    let _ = app.emit_to("dashboard", "dashboard-active", *focused);
                } else if label.starts_with("difit-") && *focused {
                    // A difit window gained focus - dashboard should be inactive
                    let _ = app.emit_to("dashboard", "dashboard-active", false);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill all difit processes on app exit
                difit_registry.kill_all();
            }
        });
}
