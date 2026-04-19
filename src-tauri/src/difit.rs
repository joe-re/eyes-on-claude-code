use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Default base branch for branch diff comparison
const DEFAULT_BASE_BRANCH: &str = "main";

/// Diff types supported by the application
#[derive(Debug, Clone, Copy)]
pub enum DiffType {
    /// Unstaged changes (working directory vs index)
    Unstaged,
    /// Staged changes (index vs HEAD)
    Staged,
    /// Latest commit diff (HEAD vs HEAD~1)
    LatestCommit,
    /// Branch diff (current branch vs main/master)
    Branch,
}

impl DiffType {
    /// Get the git diff arguments for this diff type
    fn git_diff_args(self, branch: Option<&str>) -> Result<Vec<String>, String> {
        match self {
            DiffType::Unstaged => Ok(vec!["diff".to_string()]),
            DiffType::Staged => Ok(vec!["diff".to_string(), "--cached".to_string()]),
            DiffType::LatestCommit => Ok(vec![
                "diff".to_string(),
                "HEAD~1".to_string(),
                "HEAD".to_string(),
            ]),
            DiffType::Branch => {
                let base = branch.unwrap_or(DEFAULT_BASE_BRANCH);
                if base.starts_with('-') {
                    return Err(format!("Invalid branch name: {}", base));
                }
                Ok(vec!["diff".to_string(), base.to_string()])
            }
        }
    }
}

struct RegistryInner {
    processes: HashMap<String, Child>,
    diff_hashes: HashMap<String, u64>,
}

#[derive(Debug, PartialEq)]
pub enum ProcessAction {
    /// No running process exists, start a new one
    StartNew,
    /// Process was running but diff changed, old process killed
    ReplaceExisting,
    /// Process still running with same diff, skip
    SkipUnchanged,
}

/// Registry to track running difit processes
pub struct DifitProcessRegistry {
    inner: Mutex<RegistryInner>,
}

impl DifitProcessRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner {
                processes: HashMap::new(),
                diff_hashes: HashMap::new(),
            }),
        }
    }

    pub fn register(&self, key: String, process: Child) {
        match self.inner.lock() {
            Ok(mut inner) => {
                inner.processes.insert(key, process);
            }
            Err(e) => {
                log::warn!(target: "eocc.difit", "Failed to lock registry for register: {}", e);
            }
        }
    }

    /// Atomically check process liveness and diff hash, then decide action.
    /// Kills the old process if the diff has changed.
    pub fn check_and_update(&self, key: &str, new_hash: u64) -> ProcessAction {
        match self.inner.lock() {
            Ok(mut inner) => {
                let is_alive = if let Some(process) = inner.processes.get_mut(key) {
                    match process.try_wait() {
                        Ok(Some(_)) => {
                            // Process has exited (browser tab closed)
                            inner.processes.remove(key);
                            inner.diff_hashes.remove(key);
                            false
                        }
                        Ok(None) => true,
                        Err(_) => {
                            inner.processes.remove(key);
                            inner.diff_hashes.remove(key);
                            false
                        }
                    }
                } else {
                    false
                };

                if !is_alive {
                    inner.diff_hashes.insert(key.to_string(), new_hash);
                    return ProcessAction::StartNew;
                }

                // Process is alive, check if diff content changed
                let old_hash = inner.diff_hashes.get(key).copied();
                if old_hash == Some(new_hash) {
                    return ProcessAction::SkipUnchanged;
                }

                // Diff changed: kill old process and update hash
                if let Some(mut process) = inner.processes.remove(key) {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                inner.diff_hashes.insert(key.to_string(), new_hash);
                ProcessAction::ReplaceExisting
            }
            Err(e) => {
                log::warn!(target: "eocc.difit", "Failed to lock registry: {}", e);
                ProcessAction::StartNew
            }
        }
    }

    pub fn kill_all(&self) {
        match self.inner.lock() {
            Ok(mut inner) => {
                for (_, mut process) in inner.processes.drain() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                inner.diff_hashes.clear();
            }
            Err(e) => {
                log::warn!(target: "eocc.difit", "Failed to lock registry for kill_all: {}", e);
            }
        }
    }
}

impl Default for DifitProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Get diff content for untracked files
fn get_untracked_diff(repo_path: &str) -> Vec<u8> {
    let untracked_output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(repo_path)
        .output();

    let untracked_files = match untracked_output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        _ => return Vec::new(),
    };

    if untracked_files.is_empty() {
        return Vec::new();
    }

    let mut combined_diff = Vec::new();
    for file in untracked_files {
        let diff_output = Command::new("git")
            .args(["diff", "--no-index", "--", "/dev/null", &file])
            .current_dir(repo_path)
            .output();

        if let Ok(output) = diff_output {
            if !output.stdout.is_empty() {
                combined_diff.extend_from_slice(&output.stdout);
            }
        }
    }

    combined_diff
}

/// Get diff content for the specified repository and diff type
pub fn get_diff_content(
    repo_path: &str,
    diff_type: DiffType,
    base_branch: Option<&str>,
) -> Result<Vec<u8>, String> {
    let git_args = diff_type.git_diff_args(base_branch)?;

    log::info!(target: "eocc.difit", "get_diff_content: repo={}, base_branch={:?}, git_args={:?}", repo_path, base_branch, git_args);

    let git_output = Command::new("git")
        .args(&git_args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if !git_output.status.success() {
        let stderr = String::from_utf8_lossy(&git_output.stderr);
        return Err(format!("git diff failed: {}", stderr));
    }

    let mut diff_content = git_output.stdout;

    if matches!(diff_type, DiffType::Unstaged) {
        let untracked_diff = get_untracked_diff(repo_path);
        diff_content.extend(untracked_diff);
    }

    if diff_content.is_empty() {
        return Err("No diff content to display".to_string());
    }

    Ok(diff_content)
}

/// Calculate hash of diff content
pub fn calculate_diff_hash(content: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// Start a difit server that opens in the system browser.
///
/// difit handles port allocation automatically.
/// The server auto-terminates when the browser tab is closed.
pub fn start_difit_server(
    diff_content: Vec<u8>,
    repo_path: &str,
    npx_path: Option<&str>,
) -> Result<Child, String> {
    let npx_cmd = npx_path.filter(|p| !p.is_empty()).unwrap_or("npx");

    log::info!(target: "eocc.difit", "Starting difit with npx_cmd={}", npx_cmd);

    let mut cmd = Command::new(npx_cmd);
    cmd.args(["difit"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(repo_path);

    if let Some(path) = npx_path.filter(|p| !p.is_empty()) {
        if let Some(bin_dir) = std::path::Path::new(path).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let new_path = format!("{}:{}", bin_dir.display(), current_path);
            cmd.env("PATH", new_path);
        }
    }

    let mut difit_process = cmd
        .spawn()
        .map_err(|e| format!("Failed to start difit (npx_path={}): {}", npx_cmd, e))?;

    {
        let mut stdin = difit_process
            .stdin
            .take()
            .ok_or("Failed to capture difit stdin")?;
        stdin
            .write_all(&diff_content)
            .map_err(|e| format!("Failed to write to difit stdin: {}", e))?;
    }

    log::info!(target: "eocc.difit", "Difit process spawned, browser will open automatically");

    Ok(difit_process)
}
