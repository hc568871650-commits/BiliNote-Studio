//! Portable packages keep data beside the executable; installed Studio separates it.
use std::{env, fs, path::PathBuf};

pub fn configure(identifier: &str) -> Result<(), String> {
    let installed = identifier == "com.bilinote.studio";
    let (edition, port) = match identifier {
        "com.bilinote.studio" => ("full", "38484"),
        "com.bilinote.studio.quick" => ("quick", "38483"),
        "com.bilinote.studio.full" => ("full", "38484"),
        "com.bilinote.portable.quick" => ("quick", "28483"),
        "com.bilinote.portable.full" => ("full", "28484"),
        _ => return Ok(()),
    };
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let program = exe.parent().ok_or("无法定位程序目录")?;
    let root = if installed {
        if let Some(path) = env::var_os("BILINOTE_STUDIO_DATA_ROOT") {
            let path = PathBuf::from(path);
            if !path.is_absolute() { return Err("Studio 数据目录必须是绝对路径".into()); }
            path
        } else {
            PathBuf::from(env::var_os("LOCALAPPDATA").ok_or("无法定位 LocalAppData")?).join("BiliNoteStudio")
        }
    } else { program.to_path_buf() };
    if installed {
        env::set_var("BILINOTE_INSTALLER", "1");
        env::set_var("BILINOTE_LOCAL_WHISPER", "0");
        env::set_var("BILINOTE_DATA_ROOT", &root);
    }
    for (key, directory) in [
        ("APPDATA", "AppData"), ("LOCALAPPDATA", "LocalAppData"),
        ("TEMP", "Temp"), ("TMP", "Temp"), ("WEBVIEW2_USER_DATA_FOLDER", "WebView2"),
        ("HF_HOME", "Cache/huggingface"), ("XDG_CACHE_HOME", "Cache"),
        ("NOTE_OUTPUT_DIR", "note_results"), ("OUT_DIR", "static/screenshots"),
        ("VECTOR_DB_DIR", "vector_db"), ("DATA_DIR", "data"),
    ] {
        let path = root.join(directory);
        fs::create_dir_all(&path).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
        env::set_var(key, path);
    }
    for (key, value) in [("BILINOTE_EDITION", edition), ("BILINOTE_PORTABLE", "1"), ("BACKEND_HOST", "127.0.0.1"),
        ("BACKEND_PORT", port), ("API_BASE_URL", "http://127.0.0.1"),
        ("LANGSMITH_TRACING", "false"), ("LANGCHAIN_TRACING_V2", "false")] {
        env::set_var(key, value);
    }
    env::set_var("DATABASE_URL", format!("sqlite:///{}", root.join("bili_note.db").to_string_lossy().replace('\\', "/")));
    let bin = if installed { root.join("bin") } else { program.join("bin") };
    env::set_var("FFMPEG_BIN_PATH", &bin);
    env::set_var("PATH", format!("{};{}", bin.display(), env::var("PATH").unwrap_or_default()));
    Ok(())
}

pub fn packaged_bin() -> Option<PathBuf> {
    env::var("BILINOTE_EDITION").ok()?;
    if env::var("BILINOTE_INSTALLER").ok().as_deref() == Some("1") {
        return Some(PathBuf::from(env::var_os("BILINOTE_DATA_ROOT")?).join("bin"));
    }
    Some(env::current_exe().ok()?.parent()?.join("bin"))
}

pub fn check_port(identifier: &str) -> Result<(), String> {
    if identifier == "com.bilinote.studio" || identifier.starts_with("com.bilinote.portable.") || identifier.starts_with("com.bilinote.studio.") {
        let port = env::var("BACKEND_PORT").map_err(|e| e.to_string())?;
        std::net::TcpListener::bind(format!("127.0.0.1:{port}"))
            .map_err(|_| format!("端口 {port} 已被占用，请退出同版本的其他副本后重试。为保护数据，本次不会连接已有服务。"))?;
    }
    Ok(())
}

pub fn show_error(error: &str) {
    eprintln!("{error}");
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let message: Vec<u16> = error.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "BiliNote Studio 启动失败".encode_utf16().chain(Some(0)).collect();
        MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}
