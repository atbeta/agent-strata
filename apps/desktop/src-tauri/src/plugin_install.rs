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

/// The shell's browser tools, same delivery channel as `dev-process.ts`.
pub const BROWSER_PLUGIN: &str = include_str!("../../../../plugins/browser.ts");

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

/// Install the plugins at `dir`, returning the files written.
pub fn install_plugins(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let folder = dir.join("plugin");
    std::fs::create_dir_all(&folder)?;
    let mut written = Vec::new();
    for (name, source) in [
        ("dev-process.ts", DEV_PROCESS_PLUGIN),
        ("browser.ts", BROWSER_PLUGIN),
    ] {
        let path = folder.join(name);
        std::fs::write(&path, source)?;
        written.push(path);
    }
    Ok(written)
}

/// `OPENCODE_CONFIG_CONTENT` for a server that should load our plugins.
///
/// Only `plugin` is set. Everything else the user configured stays in effect,
/// because OpenCode concatenates array fields rather than replacing them.
pub fn config_content(plugins: &[PathBuf]) -> String {
    let urls: Vec<String> = plugins.iter().map(|p| file_url(p)).collect();
    let value = serde_json::json!({ "plugin": urls });
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
    fn the_browser_plugin_asks_the_service_and_spawns_nothing() {
        assert!(BROWSER_PLUGIN.contains("STRATA_SERVICE_URL"));
        assert!(BROWSER_PLUGIN.contains("browser_navigate"));
        assert!(BROWSER_PLUGIN.contains("browser_attach"));
        // A static import cannot resolve inside the user's own OpenCode config —
        // dynamic imports for node builtins are the whole allowance.
        assert!(!BROWSER_PLUGIN.contains("\nimport "));
        assert!(!BROWSER_PLUGIN.contains("Bun.spawn"));
        // The redirect only fires inside a shell-owned server.
        assert!(BROWSER_PLUGIN.contains("tool.execute.before"));
    }

    #[test]
    fn installing_writes_the_plugins_where_the_config_points() {
        let dir = std::env::temp_dir().join(format!("strata-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let paths = install_plugins(&dir).unwrap();
        assert_eq!(paths.len(), 2);
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), DEV_PROCESS_PLUGIN);
        assert_eq!(std::fs::read_to_string(&paths[1]).unwrap(), BROWSER_PLUGIN);

        // A second install overwrites rather than appending.
        std::fs::write(&paths[0], "stale").unwrap();
        let again = install_plugins(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&again[0]).unwrap(), DEV_PROCESS_PLUGIN);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_content_names_the_plugins_as_file_urls() {
        let unix = config_content(&[
            PathBuf::from("/home/u/.local/share/strata/plugin/dev-process.ts"),
            PathBuf::from("/home/u/.local/share/strata/plugin/browser.ts"),
        ]);
        assert!(unix.contains("file:///home/u/.local/share/strata/plugin/dev-process.ts"));
        assert!(unix.contains("file:///home/u/.local/share/strata/plugin/browser.ts"));

        let windows = config_content(&[PathBuf::from(
            "C:\\Users\\u\\AppData\\Roaming\\strata\\plugin\\dev-process.ts",
        )]);
        assert!(windows.contains("file:///C:/Users/u/AppData/Roaming/strata/plugin/dev-process.ts"));
        // Backslashes would be read as escapes inside a JSON string.
        assert!(!windows.contains("\\\\"));
    }
}
