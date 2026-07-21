import type { IntegratorMcpConfig, IntegratorMcpServer } from "./bridge";

/** Written through the standard settings path; the native host reads the
 * persisted `settings.`-prefixed key when projecting enabled servers. */
export const MCP_ENABLED_KEY = "mcp.integrator.enabled";

/** One human-readable line describing what enabling a server will run. */
export function mcpLaunchPreview(server: IntegratorMcpServer): string {
  if (server.transport === "remote") return server.url ?? "";
  return [server.command ?? "", ...(server.args ?? [])].join(" ").trim();
}

/** Parse the add-server form into a config, or explain why not.
 * Args split on whitespace (no shell quoting — one token per argument);
 * env is one KEY=value per line. */
export function parseMcpForm(input: {
  transport: "stdio" | "remote";
  command: string;
  args: string;
  env: string;
  url: string;
  oauth?: boolean;
}): { config?: IntegratorMcpConfig; error?: string } {
  if (input.transport === "remote") {
    const url = input.url.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return { error: "Enter an http(s) URL." };
    return { config: { url, ...(input.oauth ? { auth: "oauth" as const } : {}) } };
  }
  const command = input.command.trim();
  if (!command) return { error: "Enter the command to run." };
  const args = input.args.trim().length > 0 ? input.args.trim().split(/\s+/) : [];
  const env: Record<string, string> = {};
  for (const line of input.env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const key = separator > 0 ? trimmed.slice(0, separator).trim() : "";
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      return { error: `Environment lines are KEY=value; “${trimmed}” is not.` };
    }
    env[key] = trimmed.slice(separator + 1).trim();
  }
  return { config: { command, args, env } };
}

/** Curated one-click server configs: official, widely used, pinned to their
 * publisher's package or endpoint. Every add lands as a file in the user's
 * MCPs folder, disabled until explicitly enabled. */
export interface CuratedMcpServer {
  name: string;
  label: string;
  description: string;
  icon: string;
  config: IntegratorMcpConfig;
}

export interface McpActivationWarning {
  title: string;
  introduction: string;
  disclosures: Array<{ title: string; detail: string }>;
  note: string;
  confirmLabel: string;
  activeLabel: string;
}

const MCP_ACTIVATION_WARNINGS: Record<string, McpActivationWarning> = {
  "robinhood-trading": {
    title: "Enable Robinhood Trading?",
    introduction: "This is a real brokerage connection, not a market-data demo.",
    disclosures: [
      {
        title: "Financial data across your accounts",
        detail:
          "Your agent can read Robinhood account numbers, balances, positions, transactions, and order history.",
      },
      {
        title: "Real order authority",
        detail:
          "Your agent can place and cancel real equity and options orders in your dedicated Agentic account.",
      },
    ],
    note: "Robinhood confines trading to the dedicated Agentic account. Disconnect or disable this connector at any time to remove future access.",
    confirmLabel: "Enable Robinhood Trading",
    activeLabel: "Real trading enabled",
  },
};

export function mcpActivationWarning(name: string): McpActivationWarning | undefined {
  return MCP_ACTIVATION_WARNINGS[name];
}

export const CURATED_MCP_SERVERS: CuratedMcpServer[] = [
  {
    name: "playwright",
    label: "Playwright browser",
    description: "Microsoft's official browser-automation MCP — drive and inspect real pages.",
    icon: "microsoft",
    config: { command: "npx", args: ["@playwright/mcp@latest"], env: {} },
  },
  {
    name: "chrome-devtools",
    label: "Chrome DevTools",
    description:
      "Google's official DevTools server — drive Chrome, inspect the DOM, network, and performance traces (Apache-2.0).",
    icon: "google",
    config: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], env: {} },
  },
  {
    name: "vercel",
    label: "Vercel",
    description:
      "Vercel's official remote server — deployments, projects, and logs. Signs in on first use.",
    icon: "vercel",
    config: { url: "https://mcp.vercel.com", auth: "oauth" },
  },
  {
    name: "supabase",
    label: "Supabase",
    description:
      "Supabase's official remote server — Postgres, auth, and edge functions. Signs in on first use.",
    icon: "supabase",
    config: { url: "https://mcp.supabase.com/mcp", auth: "oauth" },
  },
  {
    name: "stripe",
    label: "Stripe",
    description:
      "Stripe's official remote server — payments, customers, and test data. Signs in on first use.",
    icon: "stripe",
    config: { url: "https://mcp.stripe.com", auth: "oauth" },
  },
  {
    name: "robinhood-trading",
    label: "Robinhood Trading",
    description:
      "Robinhood's official Agentic Trading connector — portfolio research and real equity or options orders in a dedicated account.",
    icon: "robinhood",
    config: { url: "https://agent.robinhood.com/mcp/trading", auth: "oauth" },
  },
  {
    name: "cloudflare-docs",
    label: "Cloudflare docs",
    description:
      "Cloudflare's official documentation server — current Workers and platform docs, no sign-in.",
    icon: "cloudflare",
    config: { url: "https://docs.mcp.cloudflare.com/mcp" },
  },
  {
    name: "huggingface",
    label: "Hugging Face",
    description:
      "Hugging Face's official remote server — models, datasets, and Spaces. Signs in for private assets.",
    icon: "huggingface",
    config: { url: "https://huggingface.co/mcp", auth: "oauth" },
  },
  {
    name: "context7",
    label: "Context7 docs",
    description: "Upstash's live library-documentation server — current docs for any package.",
    icon: "community",
    config: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: {} },
  },
  {
    name: "blender",
    label: "Blender",
    description:
      "Drive Blender scenes, materials, and renders (community, MIT, 24k stars). Requires Blender with its addon and uv installed.",
    icon: "blender",
    config: { command: "uvx", args: ["blender-mcp"], env: {} },
  },
  {
    name: "github",
    label: "GitHub",
    description:
      "GitHub's official remote server — repos, issues, PRs, and actions. Signs in on first use.",
    icon: "github",
    config: { url: "https://api.githubcopilot.com/mcp/", auth: "oauth" },
  },
  {
    name: "notion",
    label: "Notion",
    description: "Notion's official remote server — pages and databases. Signs in on first use.",
    icon: "notion",
    config: { url: "https://mcp.notion.com/mcp", auth: "oauth" },
  },
  {
    name: "linear",
    label: "Linear",
    description:
      "Linear's official remote server — issues, projects, and cycles. Signs in on first use.",
    icon: "linear",
    config: { url: "https://mcp.linear.app/mcp", auth: "oauth" },
  },
  {
    name: "figma",
    label: "Figma",
    description:
      "Figma's official remote server — read designs and dev-mode context. Signs in on first use.",
    icon: "figma",
    config: { url: "https://mcp.figma.com/mcp", auth: "oauth" },
  },
  {
    name: "sentry",
    label: "Sentry",
    description:
      "Sentry's official remote server — issues, traces, and releases. Signs in on first use.",
    icon: "sentry",
    config: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  },
];
