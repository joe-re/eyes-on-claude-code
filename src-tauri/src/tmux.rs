use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

static CACHED_TMUX_PATH: Mutex<Option<String>> = Mutex::new(None);

/// Set the cached tmux path from hook events
pub fn set_cached_tmux_path(path: &str) {
    if !path.is_empty() {
        if let Ok(mut cached) = CACHED_TMUX_PATH.lock() {
            *cached = Some(path.to_string());
            log::info!(target: "eocc.tmux", "Cached tmux path set to: {}", path);
        }
    }
}

fn get_tmux_path() -> Option<PathBuf> {
    if let Ok(cached) = CACHED_TMUX_PATH.lock() {
        if let Some(ref path_str) = *cached {
            let path = PathBuf::from(path_str);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPane {
    pub session_name: String,
    pub window_index: u32,
    pub window_name: String,
    pub pane_index: u32,
    pub pane_id: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPaneSize {
    pub width: u32,
    pub height: u32,
}

fn validate_pane_id(pane_id: &str) -> Result<(), String> {
    // tmux pane ID format: %[0-9]+
    if pane_id.starts_with('%')
        && !pane_id[1..].is_empty()
        && pane_id[1..].chars().all(|c| c.is_ascii_digit())
    {
        Ok(())
    } else {
        Err(format!("Invalid pane ID format: {}", pane_id))
    }
}

fn run_tmux_command(args: &[&str]) -> Result<String, String> {
    let tmux_path = get_tmux_path().ok_or_else(|| {
        "tmux path not available. Please start a Claude Code session first.".to_string()
    })?;

    let output = Command::new(&tmux_path)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux command failed: {}", stderr.trim()))
    }
}

pub fn is_tmux_available() -> bool {
    get_tmux_path().is_some()
}

pub fn list_panes() -> Result<Vec<TmuxPane>, String> {
    let format =
        "#{session_name}|#{window_index}|#{window_name}|#{pane_index}|#{pane_id}|#{pane_active}";
    let output = run_tmux_command(&["list-panes", "-a", "-F", format])?;

    let panes: Vec<TmuxPane> = output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 6 {
                Some(TmuxPane {
                    session_name: parts[0].to_string(),
                    window_index: parts[1].parse().unwrap_or(0),
                    window_name: parts[2].to_string(),
                    pane_index: parts[3].parse().unwrap_or(0),
                    pane_id: parts[4].to_string(),
                    is_active: parts[5] == "1",
                })
            } else {
                None
            }
        })
        .collect();

    Ok(panes)
}

pub fn capture_pane(pane_id: &str) -> Result<String, String> {
    validate_pane_id(pane_id)?;
    // -p: output to stdout
    // -e: include escape sequences for colors
    // -S -: start from the beginning of history
    // -E -: end at the last line
    run_tmux_command(&[
        "capture-pane",
        "-p",
        "-e",
        "-S",
        "-",
        "-E",
        "-",
        "-t",
        pane_id,
    ])
}

pub fn send_keys(pane_id: &str, keys: &str) -> Result<(), String> {
    validate_pane_id(pane_id)?;
    log::info!(target: "eocc.tmux", "send_keys: pane_id={}, keys={}", pane_id, keys);
    let result = run_tmux_command(&["send-keys", "-t", pane_id, keys]);
    log::info!(target: "eocc.tmux", "send_keys result: {:?}", result);
    result?;
    Ok(())
}

pub fn get_pane_size(pane_id: &str) -> Result<TmuxPaneSize, String> {
    validate_pane_id(pane_id)?;
    let output = run_tmux_command(&[
        "display-message",
        "-p",
        "-t",
        pane_id,
        "#{pane_width}x#{pane_height}",
    ])?;
    let trimmed = output.trim();
    let parts: Vec<&str> = trimmed.split('x').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid pane size format: {}", trimmed));
    }
    let width = parts[0]
        .parse()
        .map_err(|_| format!("Invalid width: {}", parts[0]))?;
    let height = parts[1]
        .parse()
        .map_err(|_| format!("Invalid height: {}", parts[1]))?;
    Ok(TmuxPaneSize { width, height })
}

fn find_system_tmux() -> Option<PathBuf> {
    let common_paths = [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ];

    for path in &common_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                let p = PathBuf::from(&path_str);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

pub fn get_available_tmux_path() -> Option<PathBuf> {
    get_tmux_path().or_else(find_system_tmux)
}

pub fn start_new_session_with_claude(working_dir: &str) -> Result<String, String> {
    let tmux_path = get_available_tmux_path()
        .ok_or_else(|| "tmux is not installed or not found in PATH".to_string())?;

    let dir_path = std::path::Path::new(working_dir);
    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", working_dir));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", working_dir));
    }

    let session_name = dir_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("claude")
        .replace('.', "_")
        .replace(' ', "_");

    let unique_session_name = format!("{}_{}", session_name, std::process::id());

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "cd '{}' && {} new-session -s '{}' claude"
end tell"#,
            working_dir.replace("'", "'\\''"),
            tmux_path.display(),
            unique_session_name
        );

        let output = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("AppleScript failed: {}", stderr.trim()));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let mut terminal_found = false;

        for terminal in &terminals {
            let cmd = format!(
                "cd '{}' && {} new-session -s '{}' claude",
                working_dir.replace("'", "'\\''"),
                tmux_path.display(),
                unique_session_name
            );

            let result = if *terminal == "gnome-terminal" {
                Command::new(terminal)
                    .args(["--", "bash", "-c", &cmd])
                    .spawn()
            } else if *terminal == "konsole" {
                Command::new(terminal)
                    .args(["-e", "bash", "-c", &cmd])
                    .spawn()
            } else {
                Command::new(terminal).args(["-e", &cmd]).spawn()
            };

            if result.is_ok() {
                terminal_found = true;
                break;
            }
        }

        if !terminal_found {
            return Err("No suitable terminal emulator found".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        return Err("Windows is not supported for tmux sessions".to_string());
    }

    Ok(unique_session_name)
}
