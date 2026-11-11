use super::model::{Attention, AttentionKind};

pub(crate) const AUTH_PROMPT: &str = "请输入域账号";
pub(crate) const AUTH_REFUSED: &str = "域账号或密码错误";

const UPGRADE_MARKERS: &[&str] = &[
    "不支持当前版本",
    "不支持该版本",
    "请下载新版本",
    "需要新版本",
    "是否自动打开",
    "unsupported version",
    "unsupported protocol",
    "update required",
    "please update",
    "newer version",
];

fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{07}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) | None => {}
        }
    }
    out
}

pub fn last_meaningful_line(output: &str) -> Option<String> {
    let cleaned = strip_escapes(output);
    cleaned
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn classify(output: &str) -> Option<Attention> {
    let cleaned = strip_escapes(output);
    let message = last_meaningful_line(&cleaned)?;
    let lower = cleaned.to_lowercase();

    if cleaned.contains(AUTH_PROMPT) || cleaned.contains(AUTH_REFUSED) {
        return Some(Attention {
            kind: AttentionKind::Login,
            message,
        });
    }
    if UPGRADE_MARKERS
        .iter()
        .any(|marker| lower.contains(&marker.to_lowercase()))
    {
        return Some(Attention {
            kind: AttentionKind::Upgrade,
            message,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_gate_is_recognised_and_quoted() {
        let out = "正在检查版本…\n当前 OpenCode 版本不受支持，请下载新版本\n是否自动打开浏览器链接？(y/N)\n";
        let found = classify(out).expect("recognised");
        assert_eq!(found.kind, AttentionKind::Upgrade);
        assert_eq!(found.message, "是否自动打开浏览器链接？(y/N)");
    }

    #[test]
    fn an_english_version_gate_is_recognised_too() {
        let found = classify("Unsupported version, please update\n").expect("recognised");
        assert_eq!(found.kind, AttentionKind::Upgrade);
        assert_eq!(found.message, "Unsupported version, please update");
    }

    #[test]
    fn a_login_prompt_is_not_an_upgrade() {
        let found = classify("◇ 请输入域账号:").expect("recognised");
        assert_eq!(found.kind, AttentionKind::Login);
    }

    #[test]
    fn a_serving_server_is_not_asking_anything() {
        assert_eq!(
            classify("opencode serve\nlistening on http://127.0.0.1:4096\n"),
            None
        );
        assert_eq!(classify(""), None);
    }

    #[test]
    fn escapes_are_stripped_before_the_message_is_read() {
        let found = classify("\u{1b}[2K\u{1b}[1m不支持当前版本\u{1b}[0m\n").expect("recognised");
        assert_eq!(found.kind, AttentionKind::Upgrade);
        assert_eq!(found.message, "不支持当前版本");
    }

    #[test]
    fn the_last_readable_line_is_the_message() {
        assert_eq!(
            last_meaningful_line("first\n\n\u{1b}[0m\nsecond\n\n"),
            Some("second".to_string())
        );
        assert_eq!(last_meaningful_line("\n\n"), None);
    }
}
