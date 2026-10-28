#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

mod settings;
mod window_state;
mod courses_fs;
pub mod pdf;

/// Writes a base64-encoded file (e.g. an exported PDF) to a user-chosen path
/// coming from the save dialog. Runs with extension and destination validation.
#[tauri::command]
fn save_pdf_file(path: String, data_b64: String) -> Result<(), String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "pdf" && ext != "md" && ext != "png" && ext != "zip" {
        return Err("Only .pdf, .md, .png, and .zip file exports are permitted".into());
    }

    const CONTAINS_PATTERNS: &[&str] = &["/.ssh", "/.aws", "/.bash", "/.zsh"];
    const STARTS_WITH_PATTERNS: &[&str] = &["/etc", "/system", "/usr", "/bin", "/sbin"];

    let path_str = path.to_lowercase();
    if CONTAINS_PATTERNS.iter().any(|p| path_str.contains(p))
        || STARTS_WITH_PATTERNS.iter().any(|p| path_str.starts_with(p))
    {
        return Err("Saving to restricted system directories is not allowed".into());
    }    
    // if path_str.contains("/.ssh")
    //     || path_str.contains("/.aws")
    //     || path_str.contains("/.bash")
    //     || path_str.contains("/.zsh")
    //     || path_str.starts_with("/etc")
    //     || path_str.starts_with("/system")
    //     || path_str.starts_with("/usr")
    //     || path_str.starts_with("/bin")
    //     || path_str.starts_with("/sbin")
    // {
    //     return Err("Saving to restricted system directories is not allowed".into());
    // }

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("failed to write '{path}': {e}"))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn open_directory(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    let status = command.status().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to open course folder (exit code {:?})",
            status.code()
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn open_directory(_path: &Path) -> Result<(), String> {
    Err("Opening directories is not supported on this platform".to_string())
}

fn find_course_dir(app: &tauri::AppHandle, course_id: &str) -> Option<PathBuf> {
    let lower_id = course_id.to_lowercase();

    // 0. Custom data_dir from settings.json
    if let Some(val) = settings::get_setting_value(app, "data_dir") {
        if let Some(str_path) = val.as_str() {
            let p = PathBuf::from(str_path).join("courses").join(&lower_id);
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 1. Env variable DATA_DIR
    if let Ok(data_env) = std::env::var("DATA_DIR") {
        let p = PathBuf::from(data_env).join("courses").join(&lower_id);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. Relative to current working dir
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("data").join("courses").join(&lower_id),
            cwd.join("..").join("data").join("courses").join(&lower_id),
            cwd.join("courses").join(&lower_id),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }

    // 2b. Portable layout: data/courses beside the executable. Checked AFTER
    // cwd so the NSIS launcher ($EXEDIR cwd) still wins over its %TEMP%
    // extraction dir, and BEFORE app-data so portable folders keep their data
    // even when launched via shortcuts with a different "Start in".
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("data").join("courses").join(&lower_id);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 3. App data directory (Tauri app_data_dir for com.rezox.coursedeck)
    if let Ok(app_data) = app.path().app_data_dir() {
        let candidates = [
            app_data.join("data").join("courses").join(&lower_id),
            app_data.join("courses").join(&lower_id),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }

    // 3b. macOS and Windows direct Application Support / AppData paths
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home).join("Library/Application Support/com.rezox.coursedeck/data/courses").join(&lower_id);
        if p.exists() {
            return Some(p);
        }
    }
    let win_appdata = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|h| format!("{h}\\AppData\\Roaming")));
    if let Ok(appdata_str) = win_appdata {
        let p = PathBuf::from(appdata_str).join("com.rezox.coursedeck").join("data").join("courses").join(&lower_id);
        if p.exists() {
            return Some(p);
        }
    }

    // 4. Resource directory
    if let Ok(res) = app.path().resource_dir() {
        let candidates = [
            res.join("data").join("courses").join(&lower_id),
            res.join("courses").join(&lower_id),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }

    // Fallback: If not existing yet, candidate in cwd
    if let Ok(cwd) = std::env::current_dir() {
        let candidate_parent = cwd.join("..").join("data").join("courses");
        if candidate_parent.exists() {
            return Some(candidate_parent.join(&lower_id));
        }
        Some(cwd.join("data").join("courses").join(&lower_id))
    } else {
        None
    }
}

#[tauri::command]
fn open_course_folder(app: tauri::AppHandle, course_id: String, path: Option<String>) -> Result<(), String> {
    if course_id.is_empty()
        || course_id.len() > 64
        || !course_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Invalid course ID".into());
    }

    let target_dir = find_course_dir(&app, &course_id)
        .ok_or_else(|| format!("Course folder for '{course_id}' could not be located."))?;

    let dir_to_open = if let Some(p) = path {
        let candidate = PathBuf::from(&p);
        if candidate.exists() && (candidate.starts_with(&target_dir) || target_dir.starts_with(&candidate)) {
            candidate
        } else {
            target_dir
        }
    } else {
        target_dir
    };

    if !dir_to_open.exists() {
        let _ = std::fs::create_dir_all(&dir_to_open);
    }

    open_directory(&dir_to_open)
}

struct BackendProcess(std::sync::Mutex<Option<std::process::Child>>);

const BACKEND_PORT: u16 = 3182;

fn get_default_data_dir(app: &tauri::App) -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("data").exists() {
            return cwd.join("data");
        } else if cwd.join("..").join("data").exists() {
            return cwd.join("..").join("data");
        }
    }
    // Portable layout: data folder beside the executable (after cwd so the
    // NSIS launcher's $EXEDIR working dir still wins over its %TEMP% dir)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("data");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("data"))
        .unwrap_or_else(|_| PathBuf::from("./data"))
}

/// All sidecar stdout/stderr lands in `<data_dir>/backend.log` so packaged
/// builds leave a diagnosable trail instead of dropping output on the floor.
fn backend_log_file(data_dir: &Path) -> Option<std::fs::File> {
    let _ = std::fs::create_dir_all(data_dir);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("backend.log"))
        .ok()
}

fn log_backend_line(data_dir: &Path, message: &str) {
    use std::io::Write;
    if let Some(mut file) = backend_log_file(data_dir) {
        let _ = writeln!(file, "[{}] {}", chrono_like_timestamp(), message);
    }
}

/// RFC-3339-ish local timestamp without pulling in a chrono dependency.
fn chrono_like_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

/// Candidate filenames for the compiled Bun sidecar, per platform.
/// `bun build --compile` emits `server` on unix and `server.exe` on Windows.
fn backend_binary_names() -> Vec<&'static str> {
    if cfg!(target_os = "windows") {
        vec![
            "server.exe",
            "bin/server.exe",
            "server-x86_64-pc-windows-msvc.exe",
        ]
    } else {
        vec![
            "server",
            "bin/server",
            "server-x86_64-apple-darwin",
            "server-aarch64-apple-darwin",
        ]
    }
}

fn start_backend_process(app: &tauri::App) -> Option<std::process::Child> {
    let data_dir = if let Some(val) = settings::get_setting_value(app.handle(), "data_dir") {
        if let Some(s) = val.as_str() {
            PathBuf::from(s)
        } else {
            get_default_data_dir(app)
        }
    } else if let Ok(d) = std::env::var("DATA_DIR") {
        PathBuf::from(d)
    } else {
        get_default_data_dir(app)
    };

    let mut cmd: Option<Command> = None;

    // In debug builds, prefer running server/index.ts directly with bun so live code changes are used
    #[cfg(debug_assertions)]
    {
        if let Ok(cwd) = std::env::current_dir() {
            let script_candidates = [
                cwd.join("server").join("index.ts"),
                cwd.join("..").join("server").join("index.ts"),
            ];
            for sc in script_candidates {
                if sc.exists() {
                    let bun_bin: Option<String> = if cfg!(target_os = "windows") {
                        std::env::var("USERPROFILE")
                            .ok()
                            .and_then(|home| {
                                let p = PathBuf::from(home).join(".bun").join("bin").join("bun.exe");
                                if p.exists() {
                                    Some(p.to_string_lossy().to_string())
                                } else {
                                    None
                                }
                            })
                    } else {
                        ["/usr/local/bin/bun", "/opt/homebrew/bin/bun"]
                            .iter()
                            .find(|bp| Path::new(bp).exists())
                            .map(|bp| bp.to_string())
                            .or_else(|| {
                                std::env::var("HOME").ok().and_then(|home| {
                                    let p = PathBuf::from(home).join(".bun").join("bin").join("bun");
                                    if p.exists() {
                                        Some(p.to_string_lossy().to_string())
                                    } else {
                                        None
                                    }
                                })
                            })
                    };

                    let bun_executable = bun_bin.unwrap_or_else(|| {
                        if cfg!(target_os = "windows") {
                            "bun.exe".to_string()
                        } else {
                            "bun".to_string()
                        }
                    });

                    let mut c = Command::new(&bun_executable);
                    c.arg("run").arg(sc);
                    cmd = Some(c);
                    break;
                }
            }
        }
    }

    // 1. Check for bundled binary in resource dir
    if cmd.is_none() {
        if let Ok(res_dir) = app.path().resource_dir() {
            for name in backend_binary_names() {
                let candidate = res_dir.join(name);
                if candidate.exists() {
                    cmd = Some(Command::new(candidate));
                    break;
                }
            }
        }
    }

    // 2. Check alongside current executable
    if cmd.is_none() {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                for name in backend_binary_names() {
                    let candidate = exe_dir.join(name);
                    if candidate.exists() {
                        cmd = Some(Command::new(candidate));
                        break;
                    }
                }
            }
        }
    }

    // 3. Fallback: run server/index.ts with bun from well-known install paths
    if cmd.is_none() {
        let bun_bin: Option<String> = if cfg!(target_os = "windows") {
            std::env::var("USERPROFILE")
                .ok()
                .and_then(|home| {
                    let p = PathBuf::from(home).join(".bun").join("bin").join("bun.exe");
                    if p.exists() {
                        Some(p.to_string_lossy().to_string())
                    } else {
                        None
                    }
                })
        } else {
            ["/usr/local/bin/bun", "/opt/homebrew/bin/bun"]
                .iter()
                .find(|bp| Path::new(bp).exists())
                .map(|bp| bp.to_string())
                .or_else(|| {
                    std::env::var("HOME").ok().and_then(|home| {
                        let p = PathBuf::from(home).join(".bun").join("bin").join("bun");
                        if p.exists() {
                            Some(p.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    })
                })
        };

        let bun_executable = bun_bin.unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "bun.exe".to_string()
            } else {
                "bun".to_string()
            }
        });

        if let Ok(cwd) = std::env::current_dir() {
            let script_candidates = [
                cwd.join("server").join("index.ts"),
                cwd.join("..").join("server").join("index.ts"),
            ];
            for sc in script_candidates {
                if sc.exists() {
                    let mut c = Command::new(&bun_executable);
                    c.arg("run").arg(sc);
                    cmd = Some(c);
                    break;
                }
            }
        }
    }

    if let Some(mut command) = cmd {
        command.env("PORT", BACKEND_PORT.to_string());
        command.env("DATA_DIR", &data_dir);

        if let Ok(cwd) = std::env::current_dir() {
            if cwd.join("app").join("build").exists() {
                command.env("APP_BUILD_DIR", cwd.join("app").join("build"));
            } else if cwd.join("..").join("app").join("build").exists() {
                command.env("APP_BUILD_DIR", cwd.join("..").join("app").join("build"));
            }
        }
        if let Ok(res_dir) = app.path().resource_dir() {
            if res_dir.join("app").join("build").exists() {
                command.env("APP_BUILD_DIR", res_dir.join("app").join("build"));
            } else if res_dir.join("build").exists() {
                command.env("APP_BUILD_DIR", res_dir.join("build"));
            }
        }

        let log_file = backend_log_file(&data_dir);
        match log_file {
            Some(file) => {
                let stderr_clone = file.try_clone().ok();
                command.stdout(file);
                match stderr_clone {
                    Some(f) => {
                        command.stderr(f);
                    }
                    None => {
                        command.stderr(std::process::Stdio::null());
                    }
                }
            }
            None => {
                command.stdout(std::process::Stdio::null());
                command.stderr(std::process::Stdio::null());
            }
        }

        match command.spawn() {
            Ok(child) => {
                println!(
                    "[Tauri] Backend server started on port {BACKEND_PORT} (pid: {})",
                    child.id()
                );
                log_backend_line(
                    &data_dir,
                    &format!("backend spawned on port {BACKEND_PORT} (pid {})", child.id()),
                );
                Some(child)
            }
            Err(e) => {
                eprintln!("[Tauri] Failed to start backend server: {e}");
                log_backend_line(&data_dir, &format!("backend spawn FAILED: {e}"));
                None
            }
        }
    } else {
        println!("[Tauri] Backend server binary or script not found, skipping auto-spawn.");
        log_backend_line(&data_dir, "backend binary or script not found; auto-spawn skipped");
        None
    }
}

/// Blocks until the sidecar accepts TCP connections on the loopback port, or
/// the timeout elapses. Keeps the (initially hidden) window from appearing
/// before the API is actually reachable.
fn wait_for_backend(timeout: std::time::Duration) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], BACKEND_PORT));
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250))
            .is_ok()
        {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            settings::get_setting,
            settings::set_setting,
            save_pdf_file,
            open_course_folder,
            courses_fs::save_course_files,
            courses_fs::get_lesson_bundle,
            courses_fs::read_course_doc,
            courses_fs::save_course_doc,
            courses_fs::delete_course_doc,
            courses_fs::list_cached_courses,
            courses_fs::get_cached_course,
            courses_fs::delete_course,
            courses_fs::get_cached_checkpoints,
            courses_fs::save_checkpoint,
            courses_fs::delete_checkpoint,
            courses_fs::get_annotations,
            courses_fs::save_annotations,
            courses_fs::list_prompts,
            courses_fs::save_prompt,
            courses_fs::delete_prompt,
            pdf::pdf_get_info,
            pdf::pdf_render_page,
            pdf::pdf_render_thumbnail,
            pdf::pdf_get_page_text,
            pdf::pdf_search,
            pdf::pdf_close_document,
        ]);

    builder
        .setup(|app| {
            // Initialize native PDFium engine state
            let pdf_state = pdf::PdfEngineState(pdf::PdfEngine::new().map(std::sync::Arc::new));
            app.manage(pdf_state);

            // Start local backend server for packaged app
            let child = start_backend_process(app);
            let backend_spawned = child.is_some();
            app.manage(BackendProcess(std::sync::Mutex::new(child)));

            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();

                // Custom window state restore — held back until the backend
                // port answers (or times out) so the UI never appears before
                // the API it depends on is reachable.
                let app_handle_restore = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    if backend_spawned
                        && !wait_for_backend(std::time::Duration::from_secs(10))
                    {
                        eprintln!("[Tauri] Backend did not become ready within 10s; showing window anyway.");
                    }
                    let app_clone = app_handle_restore.clone();
                    let _ = app_handle_restore.run_on_main_thread(move || {
                        window_state::restore_window(&app_clone, "main");
                    });
                });

                // Wire up automatic state persistence
                window_state::watch_window(app.handle(), "main");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(proc) = app_handle.try_state::<BackendProcess>() {
                    if let Ok(mut lock) = proc.0.lock() {
                        if let Some(mut child) = lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
