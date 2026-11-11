use std::path::Path;
use std::time::Duration;

use super::model::{OpencodeMode, OpencodePlan};
use super::net::{free_port, port_is_free};
use super::store::read_status;

pub fn previous_port(path: &Path) -> Option<u16> {
    let url = read_status(path)?.url?;
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next()?;
    let (_, port) = host.rsplit_once(':')?;
    port.parse().ok()
}

pub fn random_password() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("CSPRNG should provide 32 bytes");
    encode_base64url_nopad(&bytes)
}

fn encode_base64url_nopad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let n = (rem[0] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
    } else if rem.len() == 2 {
        let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
    }
    out
}

/// Prefer the last port only while it is free; an unowned listener is left alone.
pub fn plan_with_port(
    mode: OpencodeMode,
    preferred: Option<u16>,
    service_port: u16,
) -> std::io::Result<OpencodePlan> {
    match mode {
        OpencodeMode::External => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "plan() only supports embed mode",
        )),
        OpencodeMode::Embed => {
            let port = match preferred {
                Some(port) if port_is_free(port) => port,
                _ => free_port()?,
            };
            let password = random_password();
            Ok(OpencodePlan {
                mode,
                port,
                username: "opencode".into(),
                password,
                url: format!("http://127.0.0.1:{port}"),
                service_port,
                api_token: None,
            })
        }
    }
}

pub fn serve_args(port: u16) -> Vec<String> {
    vec![
        "serve".into(),
        "--hostname".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ]
}

pub fn child_env(plan: &OpencodePlan) -> Vec<(String, String)> {
    let mut env = vec![
        ("OPENCODE_SERVER_USERNAME".into(), plan.username.clone()),
        ("OPENCODE_SERVER_PASSWORD".into(), plan.password.clone()),
        (
            "STRATA_SERVICE_URL".into(),
            format!("http://127.0.0.1:{}", plan.service_port),
        ),
    ];
    if let Some(token) = &plan.api_token {
        env.push(("STRATA_API_TOKEN".into(), token.clone()));
    }
    env
}

pub fn service_env(plan: &OpencodePlan) -> Vec<(String, String)> {
    vec![
        ("STRATA_OPENCODE_URL".into(), plan.url.clone()),
        ("STRATA_OPENCODE_USERNAME".into(), plan.username.clone()),
        ("STRATA_OPENCODE_PASSWORD".into(), plan.password.clone()),
    ]
}

pub(crate) fn backoff(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(1),
        2 => Duration::from_secs(2),
        3 => Duration::from_secs(4),
        4 => Duration::from_secs(8),
        _ => Duration::from_secs(30),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{sample_plan, temp_path, FREE_PORT_TEST};
    use super::*;
    use crate::embed::store::write_status;
    use crate::embed::OpencodeState;
    use std::net::TcpListener;

    #[test]
    fn serve_args_include_loopback_and_port() {
        assert_eq!(
            serve_args(43123),
            vec!["serve", "--hostname", "127.0.0.1", "--port", "43123"]
        );
    }

    #[test]
    fn child_env_sets_opencode_server_credentials() {
        let plan = sample_plan();
        let env = child_env(&plan);
        assert_eq!(
            env,
            vec![
                (
                    "OPENCODE_SERVER_USERNAME".to_string(),
                    "opencode".to_string()
                ),
                (
                    "OPENCODE_SERVER_PASSWORD".to_string(),
                    "unit-test-password-value".to_string()
                ),
                (
                    "STRATA_SERVICE_URL".to_string(),
                    "http://127.0.0.1:7700".to_string()
                ),
            ]
        );
    }

    #[test]
    fn child_env_carries_the_capability_token_when_there_is_one() {
        let mut plan = sample_plan();
        plan.api_token = Some("unit-test-token".into());
        let env = child_env(&plan);
        assert!(env
            .iter()
            .any(|(key, value)| key == "STRATA_API_TOKEN" && value == "unit-test-token"));
    }

    #[test]
    fn service_env_sets_strata_opencode_variables() {
        let plan = sample_plan();
        let env = service_env(&plan);
        assert_eq!(
            env,
            vec![
                (
                    "STRATA_OPENCODE_URL".to_string(),
                    "http://127.0.0.1:43123".to_string()
                ),
                (
                    "STRATA_OPENCODE_USERNAME".to_string(),
                    "opencode".to_string()
                ),
                (
                    "STRATA_OPENCODE_PASSWORD".to_string(),
                    "unit-test-password-value".to_string()
                ),
            ]
        );
    }

    #[test]
    fn backoff_doubles_then_caps_at_thirty_seconds() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(2), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(4), Duration::from_secs(8));
        assert_eq!(backoff(5), Duration::from_secs(30));
        assert_eq!(backoff(6), Duration::from_secs(30));
    }

    #[test]
    fn random_password_is_url_safe_base64_without_padding() {
        let password = random_password();
        assert_eq!(password.len(), 43);
        assert!(
            password
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "password {password} should match [A-Za-z0-9_-]+"
        );
    }

    #[test]
    fn plan_embed_fills_loopback_url_and_username() {
        let planned = plan_with_port(OpencodeMode::Embed, None, 7700).expect("embed plan");
        assert_eq!(planned.mode, OpencodeMode::Embed);
        assert_eq!(planned.username, "opencode");
        assert_eq!(planned.url, format!("http://127.0.0.1:{}", planned.port));
        assert_eq!(planned.password.len(), 43);
    }

    #[test]
    fn plan_external_is_invalid_input() {
        let err = plan_with_port(OpencodeMode::External, None, 7700).expect_err("external plan");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn plan_with_port_keeps_a_port_that_is_still_free() {
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..10 {
            let port = free_port().expect("free port");
            let planned =
                plan_with_port(OpencodeMode::Embed, Some(port), 7700).expect("embed plan");
            if planned.port == port {
                assert_eq!(planned.url, format!("http://127.0.0.1:{port}"));
                return;
            }
        }
        panic!("the free port was taken before plan_with_port could keep it");
    }

    #[test]
    fn plan_with_port_gives_up_a_port_that_is_taken() {
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let taken = listener.local_addr().expect("addr").port();
        let planned = plan_with_port(OpencodeMode::Embed, Some(taken), 7700).expect("embed plan");
        assert_ne!(planned.port, taken);
    }

    #[test]
    fn previous_port_reads_the_port_the_last_run_used() {
        let status_path = temp_path("status.json");
        write_status(
            &status_path,
            OpencodeMode::Embed,
            OpencodeState::Running,
            Some("http://127.0.0.1:43123"),
            None,
        )
        .expect("write running status");
        assert_eq!(previous_port(&status_path), Some(43123));
    }

    #[test]
    fn previous_port_is_none_without_a_status_file_or_a_url() {
        let status_path = temp_path("status.json");
        assert_eq!(previous_port(&status_path), None);
        write_status(
            &status_path,
            OpencodeMode::External,
            OpencodeState::External,
            None,
            None,
        )
        .expect("write external status");
        assert_eq!(previous_port(&status_path), None);
    }
}
