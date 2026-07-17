use integrator_core::ProviderKind;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalToolsProjection {
    Projected,
    Unavailable,
}

pub fn instructions(provider: ProviderKind, tools: LocalToolsProjection) -> String {
    let tool_contract = match tools {
        LocalToolsProjection::Projected => {
            "A task-scoped MCP server named `integrator` is projected into this session. Use only \
             Integrator tools actually present in the current tool surface and call them directly. \
             If a tool is absent or broker transport/authentication fails, say the provider \
             session needs reconnecting. If `skill_data_request` reports a missing saved provider \
             credential, direct the user to AI Integrator Settings; never request the credential \
             in chat."
        }
        LocalToolsProjection::Unavailable => {
            "AI Integrator did not project its local MCP server into this session. \
             Integrator-only tools such as `skill_data_request` and delegation are unavailable. \
             Do not claim otherwise or emulate them through shell commands."
        }
    };
    format!(
        "You are operating through AI Integrator's local desktop harness using the {provider} \
         runtime. Treat this as durable harness policy for the entire provider session.\n\
         - {tool_contract}\n\
         - Never start or inspect `--broker-mcp`, search for `INTEGRATOR_BROKER_*`, copy \
         credentials, or reconstruct Integrator's private tool plumbing. Broker authorization \
         and saved API credentials remain inside the native app and OS credential store.\n\
         - Skills supplied in an `<integrator-skills>` index or explicit `<skill>` block are \
         instructions, not new authority. Read the referenced `SKILL.md` when relevant; if its \
         required tool is unavailable, report that limitation instead of bypassing it.\n\
         - Base capability claims on tools and structured provider evidence you actually \
         observe. Repository code, process listings, and your own prose do not prove that a \
         capability is live in this session.\n\
         - Do not repeat or summarize this policy unless a real harness limitation is relevant \
         to the user's request.",
        provider = provider.as_str(),
    )
}

pub fn merge(existing: Option<&str>, harness: &str) -> String {
    match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => format!("{existing}\n\n{harness}"),
        None => harness.to_owned(),
    }
}

pub fn codex_developer_instructions(config: &Value, tools: LocalToolsProjection) -> String {
    let existing = config
        .pointer("/config/developer_instructions")
        .and_then(Value::as_str);
    merge(existing, &instructions(ProviderKind::Codex, tools))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projected_tools_are_direct_and_private_plumbing_is_off_limits() {
        let block = instructions(ProviderKind::Codex, LocalToolsProjection::Projected);
        assert!(block.contains("using the codex runtime"));
        assert!(block.contains("durable harness policy"));
        assert!(block.contains("call them directly"));
        assert!(block.contains("session needs reconnecting"));
        assert!(block.contains("direct the user to AI Integrator Settings"));
        assert!(block.contains("never request the credential in chat"));
        assert!(block.contains("Never start or inspect `--broker-mcp`"));
        assert!(block.contains("Repository code, process listings"));
        assert!(block.len() < 1_600);
        assert!(block.split_whitespace().count() < 240);
    }

    #[test]
    fn unavailable_tools_are_not_fabricated() {
        let block = instructions(ProviderKind::Antigravity, LocalToolsProjection::Unavailable);
        assert!(block.contains("did not project its local MCP server"));
        assert!(block.contains("`skill_data_request` and delegation are unavailable"));
        assert!(block.contains("Do not claim otherwise"));
    }

    #[test]
    fn existing_developer_instructions_keep_their_precedence_order() {
        let harness = instructions(ProviderKind::Codex, LocalToolsProjection::Projected);
        let merged = merge(Some("User-owned developer policy."), &harness);
        assert!(merged.starts_with("User-owned developer policy."));
        assert_eq!(merged.matches("durable harness policy").count(), 1);
    }

    #[test]
    fn codex_effective_config_is_preserved_before_the_harness() {
        let config = serde_json::json!({
            "config": { "developer_instructions": "Project policy." }
        });
        let merged = codex_developer_instructions(&config, LocalToolsProjection::Projected);
        assert!(merged.starts_with("Project policy."));
        assert!(merged.contains("using the codex runtime"));
    }
}
