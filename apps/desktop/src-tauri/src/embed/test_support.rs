use super::model::{OpencodeMode, OpencodePlan};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub static FREE_PORT_TEST: Mutex<()> = Mutex::new(());

pub fn temp_path(name: &str) -> PathBuf {
    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "strata-embed-{}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        seq,
        name
    ));
    fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

pub fn sample_plan() -> OpencodePlan {
    OpencodePlan {
        mode: OpencodeMode::Embed,
        port: 43123,
        username: "opencode".into(),
        password: "unit-test-password-value".into(),
        url: "http://127.0.0.1:43123".into(),
        service_port: 7700,
        api_token: None,
    }
}
