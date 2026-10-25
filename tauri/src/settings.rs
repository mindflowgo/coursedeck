use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_file_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(d) = app.path().app_data_dir() {
        let p = d.join("settings.json");
        if p.exists() {
            return Some(p);
        }
    }
    // macOS
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home).join("Library/Application Support/com.rezox.coursedeck/settings.json");
        if p.exists() {
            return Some(p);
        }
    }
    // Windows
    let win_appdata = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|h| format!("{h}\\AppData\\Roaming")));
    if let Ok(appdata_str) = win_appdata {
        let p = PathBuf::from(appdata_str).join("com.rezox.coursedeck").join("settings.json");
        if p.exists() {
            return Some(p);
        }
    }

    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

pub fn get_settings_raw(app: &AppHandle) -> Value {
    if let Some(path) = settings_file_path(app) {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(json) = serde_json::from_str(&content) {
                    return json;
                }
            }
        }
    }
    serde_json::json!({})
}

pub fn get_setting_value(app: &AppHandle, key: &str) -> Option<Value> {
    let raw = get_settings_raw(app);
    raw.get(key).cloned()
}

pub fn set_setting_value(app: &AppHandle, key: String, value: Value) -> Result<(), String> {
    let Some(path) = settings_file_path(app) else {
        return Err("Failed to resolve app data directory".to_string());
    };

    let mut raw = get_settings_raw(app);
    if let Some(obj) = raw.as_object_mut() {
        obj.insert(key, value);
    } else {
        raw = serde_json::json!({ key: value });
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let content = serde_json::to_string_pretty(&raw).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_setting(app: tauri::AppHandle, key: Option<String>) -> Result<serde_json::Value, String> {
    if let Some(k) = key {
        Ok(get_setting_value(&app, &k).unwrap_or(serde_json::Value::Null))
    } else {
        Ok(get_settings_raw(&app))
    }
}

#[tauri::command]
pub fn set_setting(app: tauri::AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    set_setting_value(&app, key, value)
}
