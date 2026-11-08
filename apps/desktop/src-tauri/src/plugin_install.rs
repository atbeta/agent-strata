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
// One file, and it stays one file: the shim asks the service which tools
// exist. A capability added to the service appears here without this module
// changing, which is the whole reason it is a shim rather than one installed
// plugin per capability.
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
pub const STRATA_SHIM: &str = include_str!("../../../../plugins/strata-shim.ts");

/// What the shim is called on disk.
///
/// Kept stable: an installer upgrade rewrites this file in place, and a rename
/// would leave the old one behind for OpenCode to load beside the new one —
/// every tool registered twice, and the stale copy pointing at routes that may
/// no longer exist.
const SHIM_FILE: &str = "strata-shim.ts";

/// Plugins an earlier version installed and this one must remove.
///
/// OpenCode loads every file in the directory, so a leftover keeps offering
/// tools against a service that no longer answers them — `browser_*` from
/// 0.25.0–0.25.3, `dev-process.ts` from before the plugin platform.
const RETIRED: [&str; 2] = ["dev-process.ts", "browser.ts"];

/// Handshake files an earlier version wrote, one directory above the plugin.
///
/// The name changed from `strata-dev-process.json` to `strata-service.json`
/// when the per-capability plugin became one shim. The old file is not read by
/// anything now, but it sits beside the config holding a capability token from
/// a previous launch — a credential left on disk for no reader.
const RETIRED_HANDSHAKES: [&str; 1] = ["strata-dev-process.json"];

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
/// Beside the plugin, by construction: `<config>/plugin/strata-shim.ts` looks
/// for `<config>/strata-service.json`, so neither side has to agree on a
/// platform path.
pub fn handshake_path(config_dir: &Path) -> PathBuf {
    config_dir.join("strata-service.json")
}

/// Install the plugin at `dir`, returning the file written.
pub fn install_plugin(dir: &Path) -> std::io::Result<PathBuf> {
    let folder = dir.join("plugin");
    std::fs::create_dir_all(&folder)?;
    let path = folder.join(SHIM_FILE);
    std::fs::write(&path, STRATA_SHIM)?;
    // Nothing this build no longer installs may keep loading. The removal is
    // best-effort: a file the user made read-only is not a reason to fail the
    // install that replaces the one next to it.
    for retired in RETIRED {
        let _ = std::fs::remove_file(folder.join(retired));
    }
    for retired in RETIRED_HANDSHAKES {
        let _ = std::fs::remove_file(dir.join(retired));
    }
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
    fn the_shim_asks_the_service_and_never_detaches() {
        // The properties this plugin exists for: it talks to the service, it
        // asks it what tools exist, and it spawns nothing of its own.
        assert!(STRATA_SHIM.contains("STRATA_SERVICE_URL"));
        assert!(STRATA_SHIM.contains("/plugins/tools"));
        assert!(STRATA_SHIM.contains("/hooks/before-tool"));
        assert!(!STRATA_SHIM.contains("Bun.spawn"));
        assert!(!STRATA_SHIM.contains("Start-Process -NoNewWindow -NoNewWindow"));
        // One export: OpenCode treats every export as a plugin. The count is
        // taken at line starts so the comment above it does not count.
        let exports = STRATA_SHIM
            .lines()
            .filter(|line| line.starts_with("export "))
            .count();
        assert_eq!(exports, 1);
        // No imports, because `@opencode-ai/plugin` is not resolvable where
        // this file is installed.
        assert!(!STRATA_SHIM.contains("from \""));
        assert!(!STRATA_SHIM.contains("from '"));
    }

    #[test]
    fn installing_writes_the_plugin_where_the_config_points() {
        let dir = std::env::temp_dir().join(format!("strata-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let stale = dir.join("plugin").join("browser.ts");
        let older = dir.join("plugin").join("dev-process.ts");
        // The old handshake lives one level up and carries a token from the
        // launch that wrote it.
        let old_handshake = dir.join("strata-dev-process.json");
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(&stale, "leftover browser plugin").unwrap();
        std::fs::write(&older, "leftover dev plugin").unwrap();
        std::fs::write(&old_handshake, "{\"url\":\"http://127.0.0.1:1\",\"token\":\"stale\"}").unwrap();
        let path = install_plugin(&dir).unwrap();
        assert!(path.is_file());
        assert_eq!(path.file_name().unwrap(), SHIM_FILE);
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, STRATA_SHIM);
        assert!(!stale.exists());
        assert!(!older.exists());
        assert!(!old_handshake.exists());

        // A second install overwrites rather than appending.
        std::fs::write(&path, "stale").unwrap();
        let again = install_plugin(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&again).unwrap(), STRATA_SHIM);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_handshake_is_beside_the_plugin() {
        // The shim finds it by walking up one directory from its own path.
        // Changing either side without the other breaks every global install.
        let dir = Path::new("/home/u/.config/opencode");
        assert_eq!(handshake_path(dir), Path::new("/home/u/.config/opencode/strata-service.json"));
        assert!(STRATA_SHIM.contains("strata-service.json"));
    }

    #[test]
    fn config_content_names_the_plugin_as_a_file_url() {
        let unix = config_content(Path::new("/home/u/.local/share/strata/plugin/strata-shim.ts"));
        assert!(unix.contains("file:///home/u/.local/share/strata/plugin/strata-shim.ts"));

        let windows = config_content(Path::new("C:\\Users\\u\\AppData\\Roaming\\strata\\plugin\\strata-shim.ts"));
        assert!(windows.contains("file:///C:/Users/u/AppData/Roaming/strata/plugin/strata-shim.ts"));
        // Backslashes would be read as escapes inside a JSON string.
        assert!(!windows.contains("\\\\"));
    }
}
