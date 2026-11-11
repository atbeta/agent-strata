use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

pub fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

pub fn port_is_free(port: u16) -> bool {
    port > 0 && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn encode_base64_std(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
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
        out.push('=');
        out.push('=');
    } else if rem.len() == 2 {
        let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

fn http_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

pub fn health_ok(url: &str, username: &str, password: &str) -> bool {
    let Some(host) = http_host(url) else {
        return false;
    };
    let addr_text = if host.contains(':') {
        host.clone()
    } else {
        format!("{host}:80")
    };
    let Ok(addr) = addr_text.parse::<SocketAddr>() else {
        return false;
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
    {
        return false;
    }
    let credential = format!("{username}:{password}");
    let request = format!(
        "GET /global/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: Basic {}\r\nConnection: close\r\n\r\n",
        encode_base64_std(credential.as_bytes())
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.flush();
    let mut buf = [0u8; 1024];
    let n = match stream.read(&mut buf) {
        Ok(0) | Err(_) => return false,
        Ok(n) => n,
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    let status_line = text.lines().next().unwrap_or("");
    status_line.contains(" 200 ")
}

#[cfg(test)]
mod tests {
    use super::super::test_support::FREE_PORT_TEST;
    use super::*;

    #[test]
    fn free_port_returns_a_port_that_accepts_a_bind() {
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..10 {
            let port = free_port().expect("free port");
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
        }
        panic!("free_port did not produce a bindable port in ten attempts");
    }

    #[test]
    fn health_ok_is_false_on_a_closed_port() {
        assert!(!health_ok("http://127.0.0.1:1", "opencode", "x"));
    }
}
