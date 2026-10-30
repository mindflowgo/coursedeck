//! Custom window state persistence — stores position/size per window label.
//!
//! - Stores coordinates in LOGICAL pixels to handle Retina/HiDPI correctly on both macOS and Windows
//! - Verifies monitor intersection so if a monitor is disconnected, position resets gracefully
//! - Restores window visibility
//! - State is saved to `settings.json` inside the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

type StateMap = HashMap<String, WindowGeometry>;

fn load_state_map(app: &AppHandle) -> StateMap {
    if let Some(val) = crate::settings::get_setting_value(app, "window_positions") {
        if let Ok(map) = serde_json::from_value(val) {
            return map;
        }
    }
    HashMap::new()
}

fn save_state_map(app: &AppHandle, map: &StateMap) {
    if let Ok(val) = serde_json::to_value(map) {
        let _ = crate::settings::set_setting_value(app, "window_positions".to_string(), val);
    }
}

fn show_restored(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Restore a window's position, size, and visibility from persisted state.
pub fn restore_window(app: &AppHandle, label: &str) {
    let map = load_state_map(app);
    let Some(geo) = map.get(label) else {
        eprintln!(
            "[WINDOW-STATE] No saved state for '{}', showing with defaults.",
            label
        );
        if let Some(window) = app.get_webview_window(label) {
            show_restored(&window);
        }
        return;
    };

    let Some(window) = app.get_webview_window(label) else {
        eprintln!("[WINDOW-STATE] Window '{}' not found during restore.", label);
        return;
    };

    eprintln!(
        "[WINDOW-STATE] Restoring '{}': {}x{} at ({}, {}) visible={}",
        label, geo.width, geo.height, geo.x, geo.y, geo.visible
    );

    use tauri::{LogicalPosition, LogicalSize, Position, Size};
    let _ = window.set_size(Size::Logical(LogicalSize::new(geo.width, geo.height)));

    // Verify if saved position intersects with any currently available monitor
    let mut is_visible_on_any_monitor = true;
    if let Ok(monitors) = window.available_monitors() {
        if !monitors.is_empty() {
            is_visible_on_any_monitor = false;
            let scale = window.scale_factor().unwrap_or(1.0);
            let phys_x = (geo.x * scale) as i32;
            let phys_y = (geo.y * scale) as i32;

            for m in monitors {
                let m_pos = m.position();
                let m_size = m.size();

                let margin = 20;
                let inside_x = phys_x >= (m_pos.x - margin) && phys_x < (m_pos.x + m_size.width as i32 + margin);
                let inside_y = phys_y >= (m_pos.y - margin) && phys_y < (m_pos.y + m_size.height as i32 + margin);

                if inside_x && inside_y {
                    is_visible_on_any_monitor = true;
                    break;
                }
            }
        }
    }

    if is_visible_on_any_monitor {
        let _ = window.set_position(Position::Logical(LogicalPosition::new(geo.x, geo.y)));
    } else {
        eprintln!(
            "[WINDOW-STATE] Saved position ({}, {}) for '{}' is off-screen. Resetting to default.",
            geo.x, geo.y, label
        );
    }

    if geo.visible {
        show_restored(&window);
    }
}

/// Persist window position, size, and visibility.
pub fn persist_window(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else { return };

    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(phys_pos) = window.outer_position() else { return };
    let Ok(phys_size) = window.outer_size() else { return };

    if phys_size.width == 0 || phys_size.height == 0 {
        return;
    }

    let visible = window.is_visible().unwrap_or(true);

    let geo = WindowGeometry {
        x: phys_pos.x as f64 / scale,
        y: phys_pos.y as f64 / scale,
        width: phys_size.width as f64 / scale,
        height: phys_size.height as f64 / scale,
        visible,
    };

    let mut map = load_state_map(app);
    map.insert(label.to_string(), geo);
    save_state_map(app, &map);
}

/// Attach move/resize/close event listeners to auto-persist window geometry
pub fn watch_window(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else { return };
    let label = label.to_string();
    let app_handle = app.clone();
    let seq = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let current_seq = seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                let app_clone = app_handle.clone();
                let lbl = label.clone();
                let seq_clone = seq.clone();

                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if seq_clone.load(std::sync::atomic::Ordering::Relaxed) == current_seq {
                        persist_window(&app_clone, &lbl);
                    }
                });
            }
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                persist_window(&app_handle, &label);
                if label == "main" {
                    crate::terminate_backend(&app_handle);
                }
            }
            _ => {}
        }
    });
}
