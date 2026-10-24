// The shell's own OpenCode plugin, installed into OpenCode's global config.
//
// OpenCode loads every file under `<config>/plugin/`, so writing it there gives
// the tools to every server the user runs — not only the one this shell
// launched. An OpenCode with no shell hands it to anyone is why the plugin
// checks for a live service before doing anything, and why the handshake file
// beside it tells it where that service is. For the server we spawn ourselves
// the plugin is also named through `OPENCODE_CONFIG_CONTENT`, which covers a
// config directory that is not writable.
//
// Why a file rather than an inline spec: OpenCode resolves plugin specs
// relative to the config file that declared them, and a `file://` URL is the
// one form that needs no such context.

use std::path::{Path, PathBuf};

/// The plugin source, compiled into the shell.
///
/// Four levels up: this file is `apps/desktop/src-tauri/src/`, and the plugin
/// lives at the repository root. `include_str!` resolves relative to the file
/// that names it, not to the crate root — a wrong depth here is a build error,
/// not a runtime one, which is the right place for it to fail.
pub const DEV_PROCESS_PLUGIN: &str = include_str!("../../../../plugins/dev-process.ts");

/// Where OpenCode keeps its global config.
///
/// Mirrors `xdg-basedir`: `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or
/// `~/.config` everywhere else. A plugin placed here is loaded by every
/// OpenCode the user starts, not only the one this shell launched — which is
/// the point, and also the reason the plugin has to be inert without us.
pub fn opencode_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENCODE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("opencode"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(dir) = std::env::var_os("APPDATA") {
            if !dir.is_empty() {
                return Some(PathBuf::from(dir).join("opencode"));
            }
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(|home| PathBuf::from(home).join(".config").join("opencode"))
}

/// The handshake a globally loaded plugin reads to find this service.
///
/// Beside the plugin, by construction: `<config>/plugin/dev-process.ts` looks
/// for `<config>/strata-dev-process.json`, so neither side has to agree on a
/// platform path.
pub fn handshake_path(config_dir: &Path) -> PathBuf {
    config_dir.join("strata-dev-process.json")
}

/// Install the plugin at `dir`, returning the file written.
pub fn install_plugin(dir: &Path) -> std::io::Result<PathBuf> {
    let folder = dir.join("plugin");
    std::fs::create_dir_all(&folder)?;
    let path = folder.join("dev-process.ts");
    std::fs::write(&path, DEV_PROCESS_PLUGIN)?;
    Ok(path)
}

/// `OPENCODE_CONFIG_CONTENT` for a server that should load our plugin.
///
/// Only `plugin` is set. Everything else the user configured stays in effect,
/// because OpenCode concatenates array fields rather than replacing them.
pub fn config_content(plugin: &Path) -> String {
    let url = file_url(plugin);
    let value = serde_json::json!({ "plugin": [url] });
    value.to_string()
}

/// A `file://` URL for a path, which is what OpenCode's plugin loader expects.
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        // A Windows path such as `C:/Users/...` needs the third slash.
        format!("file:///{text}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_asks_the_service_and_never_detaches() {
        // The two properties this plugin exists for: it talks to the service,
        // and it never spawns a process of its own.
        assert!(DEV_PROCESS_PLUGIN.contains("STRATA_SERVICE_URL"));
        assert!(DEV_PROCESS_PLUGIN.contains("dev_start"));
        assert!(!DEV_PROCESS_PLUGIN.contains("Bun.spawn"));
        assert!(!DEV_PROCESS_PLUGIN.contains("Start-Process -NoNewWindow -NoNewWindow"));
    }

    #[test]
    fn installing_writes_the_plugin_where_the_config_points() {
        let dir = std::env::temp_dir().join(format!("strata-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = install_plugin(&dir).unwrap();
        assert!(path.is_file());
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, DEV_PROCESS_PLUGIN);

        // A second install overwrites rather than appending.
        std::fs::write(&path, "stale").unwrap();
        let again = install_plugin(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&again).unwrap(), DEV_PROCESS_PLUGIN);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_content_names_the_plugin_as_a_file_url() {
        let unix = config_content(Path::new("/home/u/.local/share/strata/plugin/dev-process.ts"));
        assert!(unix.contains("file:///home/u/.local/share/strata/plugin/dev-process.ts"));

        let windows = config_content(Path::new("C:\\Users\\u\\AppData\\Roaming\\strata\\plugin\\dev-process.ts"));
        assert!(windows.contains("file:///C:/Users/u/AppData/Roaming/strata/plugin/dev-process.ts"));
        // Backslashes would be read as escapes inside a JSON string.
        assert!(!windows.contains("\\\\"));
    }
}
