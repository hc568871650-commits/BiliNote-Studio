use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use serde::Serialize;
use tauri::{Emitter, Manager, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};

// A second launch can arrive while Tauri is still creating its first window.
// Keep that request until Ready instead of losing it or creating another window.
static PENDING_SHOW: AtomicBool = AtomicBool::new(false);
static HOTKEY_THREAD_ID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Serialize)]
pub struct QuickCapturePayload {
    pub text: String,
    pub source: &'static str,
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle as _) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *ptr.add(len) != 0 && len < 8192 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            let text = String::from_utf16_lossy(slice);
            GlobalUnlock(handle as _);
            Some(text)
        })();
        CloseClipboard();
        result
    }
}

#[cfg(not(target_os = "windows"))]
fn read_windows_clipboard_text() -> Option<String> {
    None
}

pub fn emit_quick_capture(app: &tauri::AppHandle, source: &'static str) {
    let text = read_windows_clipboard_text().unwrap_or_default();
    let payload = QuickCapturePayload { text, source };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("quick-capture", payload);
    } else {
        let _ = app.emit("quick-capture", payload);
    }
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    Ok(read_windows_clipboard_text().unwrap_or_default())
}

#[cfg(target_os = "windows")]
fn parse_hotkey_spec(shortcut: &str) -> Option<(u32, u32)> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT};

    let mut mods: u32 = MOD_NOREPEAT;
    let mut vk: u32 = 0;
    for raw in shortcut.split('+') {
        let token = raw.trim().to_ascii_uppercase();
        match token.as_str() {
            "ALT" => mods |= MOD_ALT,
            "CTRL" | "CONTROL" => mods |= MOD_CONTROL,
            "SHIFT" => mods |= MOD_SHIFT,
            t if t.len() == 1 => {
                let ch = t.as_bytes()[0];
                if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
                    vk = ch as u32;
                }
            }
            _ => {}
        }
    }
    if vk == 0 || (mods & !MOD_NOREPEAT) == 0 {
        return None;
    }
    Some((mods, vk))
}

#[cfg(target_os = "windows")]
pub fn stop_quick_capture_hotkey() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

    let tid = HOTKEY_THREAD_ID.swap(0, Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            PostThreadMessageW(tid, WM_QUIT, 0, 0);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn stop_quick_capture_hotkey() {}

#[tauri::command]
pub fn configure_quick_capture_hotkey(
    app: tauri::AppHandle,
    enabled: bool,
    shortcut: String,
) -> Result<bool, String> {
    stop_quick_capture_hotkey();
    if !enabled {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

        let (mods, vk) = parse_hotkey_spec(&shortcut)
            .ok_or_else(|| format!("不支持的快捷键格式：{shortcut}"))?;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<u32, String>>(1);
        let app_handle = app.clone();
        std::thread::spawn(move || {
            const HOTKEY_ID: i32 = 0x424E;
            unsafe {
                let tid = GetCurrentThreadId();
                if RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods, vk) == 0 {
                    let _ = tx.send(Err("全局快捷键注册失败，可能已被其他应用占用".into()));
                    return;
                }
                HOTKEY_THREAD_ID.store(tid, Ordering::SeqCst);
                let _ = tx.send(Ok(tid));
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    if msg.message == WM_HOTKEY && msg.wParam == HOTKEY_ID as usize {
                        emit_quick_capture(&app_handle, "hotkey");
                    }
                }
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                let _ = HOTKEY_THREAD_ID.compare_exchange(tid, 0, Ordering::SeqCst, Ordering::SeqCst);
            }
        });
        match rx.recv() {
            Ok(Ok(_)) => Ok(true),
            Ok(Err(err)) => Err(err),
            Err(_) => Err("快捷键监听线程启动失败".into()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, shortcut);
        Ok(false)
    }
}

pub fn show_main(app: &tauri::AppHandle) {
    PENDING_SHOW.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        PENDING_SHOW.store(false, Ordering::SeqCst);
        for result in [window.show(), window.unminimize(), window.set_focus()] {
            if let Err(error) = result {
                eprintln!("Cannot restore BiliNote Studio window: {error}");
            }
        }
    }
}

pub fn show_pending_main(app: &tauri::AppHandle) {
    if PENDING_SHOW.swap(false, Ordering::SeqCst) {
        show_main(app);
    }
}

pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let preview = app.config().identifier.ends_with(".preview");
    let show = MenuItem::with_id(app, "show", if preview { "打开 BiliNote Studio 预览版" } else { "打开 BiliNote Studio" }, true, None::<&str>)?;
    let quick_capture = MenuItem::with_id(app, "quick_capture", "从剪贴板一键蒸馏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 BiliNote Studio（停止后台任务）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick_capture, &quit])?;
    let mut tray = TrayIconBuilder::with_id("bilinote")
        .tooltip(if preview { "BiliNote Studio 预览版 · 独立数据" } else { "BiliNote Studio · 点击打开，右键退出" })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quick_capture" => emit_quick_capture(app, "tray"),
            "quit" => app.exit(0),
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    if app.tray_by_id("bilinote").is_none() {
        return Err("系统托盘不可用，窗口保持打开".into());
    }
    app.get_webview_window("main").ok_or("找不到主窗口")?
        .hide().map_err(|e| e.to_string())
}

// The webview only supplies a task ID. It cannot launch arbitrary paths/programs.
fn resolve_note_folder(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    if task_id.is_empty() || task_id.len() > 100 ||
        !task_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("无效的教程 ID".into());
    }
    let root = root.canonicalize().map_err(|_| "教程目录不存在")?;
    let suffix = format!("__{task_id}");
    let mut found = None;
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().ends_with(&suffix) { continue; }
        let path = entry.path().canonicalize().map_err(|e| e.to_string())?;
        if !path.is_dir() || !path.starts_with(&root) { return Err("教程目录位置无效".into()); }
        let manifest_path = path.join("_meta/manifest.json").canonicalize().map_err(|_| "教程记录不存在")?;
        if !manifest_path.starts_with(&path) { return Err("教程记录位置无效".into()); }
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).map_err(|e| e.to_string())?
        ).map_err(|_| "教程记录无法读取")?;
        if manifest["task"]["id"].as_str() != Some(task_id) {
            return Err("教程 ID 与目录记录不一致".into());
        }
        if found.is_some() { return Err("找到重复教程目录，请检查存储位置".into()); }
        found = Some(path);
    }
    found.ok_or_else(|| "教程文件夹不存在，可能尚未保存或已被移动".into())
}

#[tauri::command]
pub fn open_note_folder(task_id: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = exe.parent().ok_or("找不到安装目录")?;
    let configured = std::env::var("NOTE_OUTPUT_DIR").unwrap_or_else(|_| "note_results".into());
    let folder = resolve_note_folder(&base.join(configured), &task_id)?;
    // Canonical Windows paths have a \\?\ prefix, which Explorer does not reliably accept.
    #[cfg(target_os = "windows")]
    {
        let raw = folder.to_string_lossy();
        let display = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else { raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string() };
        std::process::Command::new("explorer.exe").arg(display).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(folder).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "linux")]
    { std::process::Command::new("xdg-open").arg(folder).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_resolution_checks_identity_and_duplicates() {
        let root = std::env::temp_dir().join(format!("bilinote-folder-test-{}", std::process::id()));
        let folder = root.join("中文教程__test-1");
        std::fs::create_dir_all(folder.join("_meta")).unwrap();
        std::fs::write(folder.join("_meta/manifest.json"), r#"{"task":{"id":"test-1"}}"#).unwrap();
        assert_eq!(resolve_note_folder(&root, "test-1").unwrap(), folder.canonicalize().unwrap());
        assert!(resolve_note_folder(&root, "../test-1").is_err());
        assert!(resolve_note_folder(&root, "missing").is_err());
        std::fs::write(folder.join("_meta/manifest.json"), r#"{"task":{"id":"wrong"}}"#).unwrap();
        assert!(resolve_note_folder(&root, "test-1").is_err());
        std::fs::write(folder.join("_meta/manifest.json"), r#"{"task":{"id":"test-1"}}"#).unwrap();
        let duplicate = root.join("重复教程__test-1");
        std::fs::create_dir_all(duplicate.join("_meta")).unwrap();
        std::fs::copy(folder.join("_meta/manifest.json"), duplicate.join("_meta/manifest.json")).unwrap();
        assert!(resolve_note_folder(&root, "test-1").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
