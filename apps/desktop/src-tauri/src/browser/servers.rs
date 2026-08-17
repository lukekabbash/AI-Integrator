//! Local dev servers a browser tab can open.
//!
//! Listening on a port is not the same as serving a page: a machine has dozens
//! of listeners that are RPC endpoints, service brokers or the OS itself. Each
//! candidate is probed once over HTTP and only the ones that answer are
//! offered first, with everything else kept behind an explicit "show all".

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::command_api::{CommandError, CommandResult};

const PROBE_TIMEOUT: Duration = Duration::from_millis(600);
const CACHE_TTL: Duration = Duration::from_secs(15);
/// Ports below this are almost always system services, never dev servers.
const LOW_PORT_FLOOR: u16 = 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub port: u16,
    pub url: String,
    /// Owning process name when the OS will tell us, else empty.
    pub process: String,
    /// True when an HTTP probe answered with something a browser can render.
    pub serves_web: bool,
    /// Page title from the probe, when the response carried one.
    pub title: Option<String>,
}

struct Cached {
    at: Instant,
    servers: Vec<LocalServer>,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn browser_local_servers(refresh: Option<bool>) -> CommandResult<Vec<LocalServer>> {
    if refresh != Some(true) {
        let cached = cache().lock().unwrap_or_else(|error| error.into_inner());
        if let Some(entry) = cached.as_ref()
            && entry.at.elapsed() < CACHE_TTL
        {
            return Ok(entry.servers.clone());
        }
    }
    let servers = tauri::async_runtime::spawn_blocking(discover)
        .await
        .map_err(|_| CommandError {
            code: "worker-failed",
            message: "the port scan stopped unexpectedly".into(),
        })?;
    let mut cached = cache().lock().unwrap_or_else(|error| error.into_inner());
    *cached = Some(Cached {
        at: Instant::now(),
        servers: servers.clone(),
    });
    Ok(servers)
}

fn discover() -> Vec<LocalServer> {
    let listeners = listening_ports();
    let names = process_names();
    let mut servers: Vec<LocalServer> = listeners
        .into_iter()
        .filter(|(port, _)| *port >= LOW_PORT_FLOOR)
        .map(|(port, pid)| {
            let (serves_web, title) = probe(port);
            LocalServer {
                port,
                url: format!("http://localhost:{port}"),
                process: names.get(&pid).cloned().unwrap_or_default(),
                serves_web,
                title,
            }
        })
        .collect();
    // Web servers first, then by port so the list is stable between scans.
    servers.sort_by(|a, b| b.serves_web.cmp(&a.serves_web).then(a.port.cmp(&b.port)));
    servers
}

/// TCP ports in LISTEN state, with the owning pid when the OS reports one.
fn listening_ports() -> Vec<(u16, u32)> {
    let mut found: HashMap<u16, u32> = HashMap::new();
    #[cfg(windows)]
    let output = run("netstat", &["-ano", "-p", "TCP"]);
    #[cfg(not(windows))]
    let output =
        run("lsof", &["-iTCP", "-sTCP:LISTEN", "-P", "-n"]).or_else(|| run("ss", &["-ltnp"]));
    let Some(text) = output else {
        return Vec::new();
    };
    for line in text.lines() {
        if !line.to_ascii_uppercase().contains("LISTEN") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Local address is the first field that carries a port and a host we own.
        let Some(local) = fields.iter().find(|field| {
            field.contains(':')
                && field
                    .rsplit(':')
                    .next()
                    .is_some_and(|port| port.parse::<u16>().is_ok())
        }) else {
            continue;
        };
        let host = local.rsplit_once(':').map(|(host, _)| host).unwrap_or("");
        let loopback_or_any = host.is_empty()
            || host.contains("127.0.0.1")
            || host.contains("0.0.0.0")
            || host.contains("[::]")
            || host.contains("[::1]")
            || host.starts_with('*');
        if !loopback_or_any {
            continue;
        }
        let Some(port) = local
            .rsplit(':')
            .next()
            .and_then(|port| port.parse::<u16>().ok())
        else {
            continue;
        };
        let pid = fields
            .last()
            .and_then(|field| field.trim().parse::<u32>().ok())
            .unwrap_or(0);
        found.entry(port).or_insert(pid);
    }
    let mut ports: Vec<(u16, u32)> = found.into_iter().collect();
    ports.sort_by_key(|(port, _)| *port);
    ports
}

#[cfg(windows)]
fn process_names() -> HashMap<u32, String> {
    let mut names = HashMap::new();
    let Some(text) = run("tasklist", &["/fo", "csv", "/nh"]) else {
        return names;
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split("\",\"").collect();
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0]
            .trim_matches('"')
            .trim_end_matches(".exe")
            .to_string();
        if let Ok(pid) = fields[1].trim_matches('"').trim().parse::<u32>() {
            names.insert(pid, name);
        }
    }
    names
}

#[cfg(not(windows))]
fn process_names() -> HashMap<u32, String> {
    HashMap::new()
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    // Without this the scan pops a console window on screen for each helper it
    // runs — a black rectangle flashing over the app every time a blank tab
    // looks for dev servers.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// One bounded GET. A page answers with HTML; anything else is not offered.
fn probe(port: u16) -> (bool, Option<String>) {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return (false, None);
    };
    let Ok(response) = client.get(format!("http://127.0.0.1:{port}/")).send() else {
        return (false, None);
    };
    let status = response.status();
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"));
    if !(status.is_success() || status.is_redirection()) {
        return (false, None);
    }
    if !html {
        return (status.is_redirection(), None);
    }
    let body = response.text().unwrap_or_default();
    (true, page_title(&body))
}

fn page_title(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open = lower[start..].find('>')? + start + 1;
    let end = lower[open..].find("</title>")? + open;
    let title = body[open..end].trim();
    (!title.is_empty()).then(|| {
        let trimmed: String = title.chars().take(80).collect();
        trimmed
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_page_title_case_insensitively() {
        assert_eq!(
            page_title("<html><HEAD><Title>Vite + React</Title>"),
            Some("Vite + React".into())
        );
        assert_eq!(page_title("<title>   </title>"), None);
        assert_eq!(page_title("<html><body>no title</body>"), None);
    }

    #[test]
    fn orders_web_servers_before_other_listeners() {
        let mut servers = [
            LocalServer {
                port: 5173,
                url: "http://localhost:5173".into(),
                process: "node".into(),
                serves_web: true,
                title: None,
            },
            LocalServer {
                port: 3000,
                url: "http://localhost:3000".into(),
                process: "node".into(),
                serves_web: true,
                title: None,
            },
            LocalServer {
                port: 49664,
                url: "http://localhost:49664".into(),
                process: "lsass".into(),
                serves_web: false,
                title: None,
            },
        ];
        servers.sort_by(|a, b| b.serves_web.cmp(&a.serves_web).then(a.port.cmp(&b.port)));
        assert_eq!(
            servers.iter().map(|s| s.port).collect::<Vec<_>>(),
            [3000, 5173, 49664]
        );
    }
}
