//! Which of a project's npm scripts is a dev server.
//!
//! Pure by design: `package.json` text in, candidate specs out. No filesystem
//! walk, no process, no guessing about what is installed — so the table test
//! at the bottom of this file is the whole behaviour, and a project that is
//! not a Node project simply yields nothing.
//!
//! The guess is deliberately shallow. We offer the scripts whose names mean
//! "serve this" and let the user pick; inspecting script bodies to decide
//! whether something is *really* a server is how a detector starts being wrong
//! confidently. The one thing we do read out of the body is a declared port,
//! because knowing it up front is what lets a tab open on the right URL.

use std::{collections::BTreeMap, path::Path};

use serde_json::Value;

use super::ServerSpec;

/// Script names that mean "serve this project", in the order we offer them.
const SERVER_SCRIPTS: &[&str] = &["dev", "start", "serve"];
/// Monorepos split the dev script per package: `dev:web`, `dev:api`.
const SERVER_SCRIPT_PREFIX: &str = "dev:";
/// A package can declare a hundred scripts; the picker shows a short list.
const MAX_CANDIDATES: usize = 8;
/// Runners that take `run <script>` with the same spelling npm does.
const KNOWN_RUNNERS: &[&str] = &["npm", "pnpm", "yarn", "bun"];

/// Every script in `package_json` that looks like a dev server, as specs ready
/// to hand to `DevServers::start`.
pub fn candidates(package_json: &str, cwd: &Path) -> Vec<ServerSpec> {
    let Ok(root) = serde_json::from_str::<Value>(package_json) else {
        return Vec::new();
    };
    let Some(scripts) = root.get("scripts").and_then(Value::as_object) else {
        return Vec::new();
    };
    let runner = package_manager(&root);
    let mut specs: Vec<ServerSpec> = scripts
        .iter()
        .filter_map(|(name, body)| {
            let body = body.as_str()?;
            is_server_script(name).then(|| ServerSpec {
                label: name.clone(),
                program: runner.clone(),
                args: vec!["run".into(), name.clone()],
                cwd: cwd.to_path_buf(),
                env: BTreeMap::new(),
                port: declared_port(body),
            })
        })
        .collect();
    // `dev` before `start` before `serve` before the `dev:*` variants, then
    // alphabetically, so the list is stable between reads.
    specs.sort_by(|left, right| {
        rank(&left.label)
            .cmp(&rank(&right.label))
            .then_with(|| left.label.cmp(&right.label))
    });
    specs.truncate(MAX_CANDIDATES);
    specs
}

fn is_server_script(name: &str) -> bool {
    SERVER_SCRIPTS.contains(&name) || name.starts_with(SERVER_SCRIPT_PREFIX)
}

fn rank(name: &str) -> usize {
    SERVER_SCRIPTS
        .iter()
        .position(|known| *known == name)
        .unwrap_or(SERVER_SCRIPTS.len())
}

/// The runner the project asked for. Corepack writes `pnpm@9.1.0` here, and
/// running a pnpm workspace through npm fails in ways that read as the dev
/// server being broken.
fn package_manager(root: &Value) -> String {
    root.get("packageManager")
        .and_then(Value::as_str)
        .map(|declared| declared.split('@').next().unwrap_or(declared).trim())
        .filter(|name| KNOWN_RUNNERS.contains(name))
        .unwrap_or("npm")
        .to_string()
}

/// A port written into the script itself, as `--port 4180`, `--port=4180` or a
/// leading `PORT=4180`. Anything else we learn later from the port scan.
fn declared_port(script: &str) -> Option<u16> {
    let tokens: Vec<&str> = script.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        let inline = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("PORT="));
        if let Some(value) = inline
            && let Ok(port) = value.trim_matches(['"', '\'']).parse::<u16>()
        {
            return Some(port);
        }
        if *token == "--port"
            && let Some(next) = tokens.get(index + 1)
            && let Ok(port) = next.trim_matches(['"', '\'']).parse::<u16>()
        {
            return Some(port);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn summarise(json: &str) -> Vec<(String, String, Vec<String>, Option<u16>)> {
        candidates(json, &PathBuf::from("H:/Code/example"))
            .into_iter()
            .map(|spec| (spec.label, spec.program, spec.args, spec.port))
            .collect()
    }

    #[test]
    fn reads_dev_server_scripts_out_of_package_json() {
        struct Case {
            name: &'static str,
            json: &'static str,
            expected: Vec<(&'static str, &'static str, Option<u16>)>,
        }
        let cases = [
            Case {
                name: "no scripts block at all",
                json: r#"{"name":"thing","version":"1.0.0"}"#,
                expected: vec![],
            },
            Case {
                name: "scripts, but none of them serve anything",
                json: r#"{"scripts":{"build":"tsc","test":"vitest"}}"#,
                expected: vec![],
            },
            Case {
                name: "one dev script",
                json: r#"{"scripts":{"build":"tsc","dev":"vite"}}"#,
                expected: vec![("dev", "npm", None)],
            },
            Case {
                name: "several candidates, offered in a stable order",
                json: r#"{"scripts":{"serve":"http-server","start":"node server.js","dev":"vite","dev:api":"nodemon api"}}"#,
                expected: vec![
                    ("dev", "npm", None),
                    ("start", "npm", None),
                    ("serve", "npm", None),
                    ("dev:api", "npm", None),
                ],
            },
            Case {
                name: "the declared port is read out of the script body",
                json: r#"{"scripts":{"dev":"vite --port 4180 --strictPort","dev:alt":"vite --port=4181","dev:env":"PORT=3000 next dev"}}"#,
                expected: vec![
                    ("dev", "npm", Some(4180)),
                    ("dev:alt", "npm", Some(4181)),
                    ("dev:env", "npm", Some(3000)),
                ],
            },
            Case {
                name: "corepack's runner is honoured",
                json: r#"{"packageManager":"pnpm@9.1.0","scripts":{"dev":"vite"}}"#,
                expected: vec![("dev", "pnpm", None)],
            },
            Case {
                name: "an unknown runner falls back to npm rather than guessing",
                json: r#"{"packageManager":"nifty@1","scripts":{"dev":"vite"}}"#,
                expected: vec![("dev", "npm", None)],
            },
            Case {
                name: "malformed json yields nothing instead of failing",
                json: r#"{"scripts":{"dev":"vite",,}"#,
                expected: vec![],
            },
            Case {
                name: "a scripts value that is not an object",
                json: r#"{"scripts":"see the makefile"}"#,
                expected: vec![],
            },
            Case {
                name: "empty input",
                json: "",
                expected: vec![],
            },
        ];
        for case in cases {
            let found = summarise(case.json);
            let expected: Vec<(String, String, Vec<String>, Option<u16>)> = case
                .expected
                .iter()
                .map(|(label, runner, port)| {
                    (
                        (*label).to_string(),
                        (*runner).to_string(),
                        vec!["run".to_string(), (*label).to_string()],
                        *port,
                    )
                })
                .collect();
            assert_eq!(found, expected, "case: {}", case.name);
        }
    }

    #[test]
    fn the_candidate_list_is_bounded() {
        let scripts: Vec<String> = (0..40)
            .map(|index| format!("\"dev:pkg{index}\":\"vite\""))
            .collect();
        let json = format!("{{\"scripts\":{{{}}}}}", scripts.join(","));
        assert_eq!(summarise(&json).len(), MAX_CANDIDATES);
    }

    #[test]
    fn the_working_directory_travels_with_the_spec() {
        let specs = candidates(r#"{"scripts":{"dev":"vite"}}"#, &PathBuf::from("H:/Code/x"));
        assert_eq!(specs[0].cwd, PathBuf::from("H:/Code/x"));
        assert!(specs[0].env.is_empty(), "detection never invents environment");
    }
}
