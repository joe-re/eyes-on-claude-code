use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{LazyLock, Mutex};

static ANSI_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap());

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
    let output = run_tmux_command(&[
        "capture-pane",
        "-p",
        "-e",
        "-S",
        "-",
        "-E",
        "-",
        "-t",
        pane_id,
    ])?;

    // Trim trailing empty/whitespace-only lines to avoid excessive scrolling
    // Strip ANSI codes when checking if a line has visible content
    let lines: Vec<&str> = output.lines().collect();
    let last_non_empty = lines
        .iter()
        .rposition(|line| {
            let stripped = ANSI_REGEX.replace_all(line, "");
            !stripped.trim().is_empty()
        })
        .map(|i| i + 1)
        .unwrap_or(0);
    let trimmed: String = lines[..last_non_empty].join("\n");
    Ok(format!("{}\n", trimmed))
}

pub fn send_keys(pane_id: &str, keys: &str) -> Result<(), String> {
    validate_pane_id(pane_id)?;
    log::info!(target: "eocc.tmux", "send_keys: pane_id={}, keys={}", pane_id, keys);
    let result = run_tmux_command(&["send-keys", "-t", pane_id, keys]);
    log::info!(target: "eocc.tmux", "send_keys result: {:?}", result);
    result?;
    Ok(())
}

pub fn send_literal(pane_id: &str, text: &str) -> Result<(), String> {
    validate_pane_id(pane_id)?;
    log::info!(target: "eocc.tmux", "send_literal: pane_id={}, text={}", pane_id, text);
    let result = run_tmux_command(&["send-keys", "-t", pane_id, "-l", text]);
    log::info!(target: "eocc.tmux", "send_literal result: {:?}", result);
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxCursorPosition {
    pub x: u32,
    pub y: u32,
    pub history_size: u32,
}

pub fn get_cursor_position(pane_id: &str) -> Result<TmuxCursorPosition, String> {
    validate_pane_id(pane_id)?;
    let output = run_tmux_command(&[
        "display-message",
        "-p",
        "-t",
        pane_id,
        "#{cursor_x},#{cursor_y},#{history_size}",
    ])?;
    let trimmed = output.trim();
    let parts: Vec<&str> = trimmed.split(',').collect();
    if parts.len() != 3 {
        return Err(format!("Invalid cursor position format: {}", trimmed));
    }
    let x = parts[0]
        .parse()
        .map_err(|_| format!("Invalid cursor x: {}", parts[0]))?;
    let y = parts[1]
        .parse()
        .map_err(|_| format!("Invalid cursor y: {}", parts[1]))?;
    let history_size = parts[2]
        .parse()
        .map_err(|_| format!("Invalid history_size: {}", parts[2]))?;
    Ok(TmuxCursorPosition { x, y, history_size })
}

pub fn rename_session(pane_id: &str, new_name: &str) -> Result<(), String> {
    validate_pane_id(pane_id)?;
    run_tmux_command(&["rename-session", "-t", pane_id, new_name])?;
    Ok(())
}
