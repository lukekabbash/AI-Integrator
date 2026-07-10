import type {
  ChildAgent,
  DiffFile,
  GitSnapshot,
  ProjectSummary,
  RuntimeConnection,
  TaskSummary,
  TranscriptEvent,
  UsageSnapshot,
} from "./bridge";

export interface WorkspaceSnapshot {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeTaskId: string;
  activeProjectId: string;
  runtimes: RuntimeConnection[];
  transcript: TranscriptEvent[];
  children: ChildAgent[];
  usage: UsageSnapshot;
  git: GitSnapshot;
}

export function createEmptySnapshot(): WorkspaceSnapshot {
  return {
    projects: [],
    tasks: [],
    activeTaskId: "",
    activeProjectId: "",
    runtimes: [],
    transcript: [],
    children: [],
    usage: {
      tokens: 0,
      equivalentUsd: 0,
      metrics: [
        {
          label: "Usage",
          value: "Unavailable",
          provenance: "unavailable",
          detail: "No provider usage telemetry has been observed yet.",
        },
      ],
    },
    git: {
      branch: "",
      upstream: "Not published",
      ahead: 0,
      behind: 0,
      worktree: "",
      files: [],
      commits: [],
    },
  };
}

const diff: DiffFile[] = [
  {
    path: "src/runtime/router.ts",
    status: "modified",
    additions: 14,
    deletions: 6,
    staged: false,
    lines: [
      {
        kind: "hunk",
        content: "@@ -42,11 +42,19 @@ export async function selectRoute(input: RouteInput) {",
      },
      {
        oldNumber: 42,
        newNumber: 42,
        kind: "context",
        content: "  const available = await registry.available();",
      },
      {
        oldNumber: 43,
        kind: "delete",
        content: "  const provider = input.provider ?? 'codex';",
        tokens: [
          { text: "  const ", kind: "keyword" },
          { text: "provider", kind: "plain" },
          { text: " = input.provider ?? ", kind: "plain" },
          { text: "'codex'", kind: "string" },
          { text: ";", kind: "plain" },
        ],
      },
      {
        newNumber: 43,
        kind: "add",
        content: "  const provider = resolveProvider(input, available);",
        tokens: [
          { text: "  const ", kind: "keyword" },
          { text: "provider", kind: "plain" },
          { text: " = ", kind: "plain" },
          { text: "resolveProvider", kind: "function" },
          { text: "(input, available);", kind: "plain" },
        ],
      },
      {
        newNumber: 44,
        kind: "add",
        content: "  const budget = await usage.readHeadroom(provider);",
        tokens: [
          { text: "  const ", kind: "keyword" },
          { text: "budget", kind: "plain" },
          { text: " = ", kind: "plain" },
          { text: "await ", kind: "keyword" },
          { text: "usage.readHeadroom", kind: "function" },
          { text: "(provider);", kind: "plain" },
        ],
      },
      { oldNumber: 44, newNumber: 45, kind: "context", content: "" },
      {
        newNumber: 46,
        kind: "add",
        content: "  // Subscription pressure never masquerades as API cost.",
        tokens: [
          { text: "  // Subscription pressure never masquerades as API cost.", kind: "comment" },
        ],
      },
      {
        newNumber: 47,
        kind: "add",
        content: "  return registry.create({ provider, budget, input });",
        tokens: [
          { text: "  return ", kind: "keyword" },
          { text: "registry.create", kind: "function" },
          { text: "({ provider, budget, input });", kind: "plain" },
        ],
      },
      { oldNumber: 45, kind: "delete", content: "  return registry.create(provider, input);" },
      { oldNumber: 46, newNumber: 48, kind: "context", content: "}" },
    ],
  },
  {
    path: "src/components/UsageMeter.tsx",
    status: "added",
    additions: 48,
    deletions: 0,
    staged: true,
    lines: [
      { kind: "hunk", content: "@@ -0,0 +1,8 @@" },
      {
        newNumber: 1,
        kind: "add",
        content: "export function UsageMeter({ value }: UsageMeterProps) {",
        tokens: [
          { text: "export function ", kind: "keyword" },
          { text: "UsageMeter", kind: "function" },
          { text: "({ value }: ", kind: "plain" },
          { text: "UsageMeterProps", kind: "type" },
          { text: ") {", kind: "plain" },
        ],
      },
      { newNumber: 2, kind: "add", content: "  return <meter min={0} max={100} value={value} />;" },
      { newNumber: 3, kind: "add", content: "}" },
    ],
  },
  {
    path: "src/styles/legacy-provider-colors.css",
    status: "deleted",
    additions: 0,
    deletions: 31,
    staged: false,
    lines: [
      { kind: "hunk", content: "@@ -1,4 +0,0 @@" },
      { oldNumber: 1, kind: "delete", content: ".provider-claude { background: #c9825f; }" },
      { oldNumber: 2, kind: "delete", content: ".provider-codex { background: #10a37f; }" },
      { oldNumber: 3, kind: "delete", content: ".provider-grok { background: #111827; }" },
    ],
  },
];

export function createDemoSnapshot(): WorkspaceSnapshot {
  const projects: ProjectSummary[] = [
    {
      id: "integrator",
      name: "AI Integrator",
      path: "H:\\Code\\integrator-3",
      branch: "feature/v1-native-app",
      dirtyFiles: 3,
      expanded: true,
    },
    {
      id: "lotmind",
      name: "Lotmind AI",
      path: "H:\\Code\\Lotmind AI",
      branch: "main",
      dirtyFiles: 0,
      expanded: false,
    },
    {
      id: "eve",
      name: "EVE OS",
      path: "F:\\Code\\eve-os-2",
      branch: "dev",
      dirtyFiles: 1,
      expanded: false,
    },
  ];

  const tasks: TaskSummary[] = [
    {
      id: "v1-shell",
      projectId: "integrator",
      title: "Construct the native v1 workspace",
      status: "running",
      runtime: "codex",
      model: "GPT-5.6 Sol",
      updatedAt: new Date().toISOString(),
      unread: false,
      worktree: "feature/v1-native-app",
    },
    {
      id: "adapter-audit",
      projectId: "integrator",
      title: "Certify Codex and ACP adapters",
      status: "waiting",
      runtime: "cursor",
      model: "Composer 3",
      updatedAt: "2026-07-10T05:42:00.000Z",
      unread: true,
      worktree: "agent/adapter-audit",
    },
    {
      id: "theme-pass",
      projectId: "integrator",
      title: "Tune coordinated theme presets",
      status: "completed",
      runtime: "claude",
      model: "Claude 5 Fable",
      updatedAt: "2026-07-10T04:18:00.000Z",
      worktree: "agent/theme-pass",
    },
    {
      id: "overnight",
      projectId: "lotmind",
      title: "Mobile intake overnight agent",
      status: "completed",
      runtime: "codex",
      model: "GPT-5.6",
      updatedAt: "2026-07-09T22:16:00.000Z",
    },
  ];

  const runtimes: RuntimeConnection[] = [
    {
      id: "codex",
      name: "Codex",
      command: "codex app-server",
      version: "0.144.0",
      account: "ChatGPT subscription",
      status: "connected",
      fidelity: "native",
      models: ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.5 Codex"],
      detail: "Native app-server events, approvals, plans, and usage.",
    },
    {
      id: "cursor",
      name: "Cursor",
      command: "cursor-agent --acp",
      version: "3.9.21",
      status: "degraded",
      fidelity: "acp",
      models: ["Composer 3", "Auto"],
      detail: "Desktop detected; agent CLI setup is required for structured runs.",
    },
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      version: "2.1.206",
      account: "Claude Max",
      status: "connected",
      fidelity: "structured",
      models: ["Claude 5 Fable", "Claude 5 Sonnet", "Claude 5 Opus"],
      detail: "Existing vendor login reused. Subscription quota percentage is not exposed.",
    },
    {
      id: "grok",
      name: "Grok",
      command: "grok",
      status: "not_installed",
      fidelity: "acp",
      models: ["Grok 4.5"],
      detail: "Install the vendor runtime, then return to this setup step.",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini --acp",
      version: "0.42.0",
      status: "login_required",
      fidelity: "acp",
      models: ["Gemini 3 Pro"],
      detail: "Installed. Finish the vendor-owned browser login to enable it.",
    },
  ];

  const transcript: TranscriptEvent[] = [
    {
      id: "u1",
      kind: "user",
      body: "Build the polished native v1 end to end. Keep it agent-first, local, deeply customizable, and calm under concurrency.",
      timestamp: "2026-07-10T05:12:00.000Z",
    },
    {
      id: "p1",
      kind: "activity",
      title: "Plan",
      body: "Defined the walking skeleton and assigned isolated implementation slices.",
      timestamp: "2026-07-10T05:12:08.000Z",
      status: "success",
      children: [
        {
          id: "p1-1",
          kind: "activity",
          body: "Inspect product contracts and reusable brand assets",
          timestamp: "2026-07-10T05:12:10.000Z",
          status: "success",
        },
        {
          id: "p1-2",
          kind: "activity",
          body: "Build native runtime and local session store",
          timestamp: "2026-07-10T05:13:00.000Z",
          status: "running",
          meta: "Carver · GPT-5.6 Terra",
        },
        {
          id: "p1-3",
          kind: "activity",
          body: "Construct the polished shared UI",
          timestamp: "2026-07-10T05:14:00.000Z",
          status: "running",
          meta: "Terra · GPT-5.6",
        },
      ],
    },
    {
      id: "t1",
      kind: "tool",
      title: "Inspected project",
      body: "Read 12 product contracts, detected the new Tauri scaffold, and preserved the source repositories.",
      timestamp: "2026-07-10T05:15:00.000Z",
      status: "success",
      meta: "42 files · 1.8 s",
    },
    {
      id: "a1",
      kind: "assistant",
      body: "The native shell is underway. The first slice establishes one durable task surface, a typed local bridge, broker-visible child work, reviewable Git state, and settings that replace the project rail instead of becoming another cramped sidebar.",
      timestamp: "2026-07-10T05:18:00.000Z",
      status: "neutral",
    },
    {
      id: "n1",
      kind: "notice",
      title: "Working locally",
      body: "Credentials remain in each vendor CLI. Session history and usage evidence are stored on this device.",
      timestamp: "2026-07-10T05:18:05.000Z",
      status: "neutral",
    },
  ];

  const children: ChildAgent[] = [
    {
      id: "root",
      name: "Lead",
      role: "Orchestrator",
      runtime: "codex",
      model: "GPT-5.6 Sol",
      status: "running",
      activity: "Integrating native runtime and UI slices",
      elapsed: "18m",
      usagePercent: 34,
      worktree: "feature/v1-native-app",
      messages: 9,
    },
    {
      id: "terra",
      parentId: "root",
      name: "Terra",
      role: "Interface",
      runtime: "codex",
      model: "GPT-5.6 Terra",
      status: "running",
      activity: "Building workspace, review, and customization",
      elapsed: "12m",
      usagePercent: 18,
      worktree: "agent/ui-workspace",
      messages: 3,
    },
    {
      id: "carver",
      parentId: "root",
      name: "Carver",
      role: "Native runtime",
      runtime: "codex",
      model: "GPT-5.6 Terra",
      status: "running",
      activity: "Supervising PTY and adapter processes",
      elapsed: "15m",
      usagePercent: 21,
      worktree: "agent/native-runtime",
      messages: 5,
    },
    {
      id: "ampere",
      parentId: "root",
      name: "Ampere",
      role: "Release audit",
      runtime: "claude",
      model: "Claude 5 Fable",
      status: "completed",
      activity: "Returned packaging and accessibility risks",
      elapsed: "7m",
      usagePercent: 8,
      worktree: "agent/release-audit",
      messages: 2,
    },
  ];

  const usage: UsageSnapshot = {
    subscriptionPercent: 34,
    resetAt: "Jul 14, 8:00 PM",
    tokens: 182_430,
    equivalentUsd: 12.84,
    actualUsd: 0,
    metrics: [
      {
        label: "Subscription usage",
        value: "34%",
        numeric: 34,
        provenance: "vendor_exact",
        detail: "Codex five-day plan window",
      },
      {
        label: "Tokens",
        value: "182.4k",
        numeric: 182430,
        provenance: "local_observed",
        detail: "Measured across this task and children",
      },
      {
        label: "API equivalent",
        value: "$12.84",
        numeric: 12.84,
        provenance: "estimated",
        detail: "Informational model-rate estimate",
      },
      {
        label: "Actual spend",
        value: "$0.00",
        numeric: 0,
        provenance: "vendor_exact",
        detail: "Covered by active subscriptions",
      },
    ],
  };

  const git: GitSnapshot = {
    branch: "feature/v1-native-app",
    upstream: "origin/feature/v1-native-app",
    ahead: 2,
    behind: 0,
    worktree: "H:\\Code\\integrator-3",
    files: diff,
    commits: [
      { id: "working", subject: "Working tree changes", relativeTime: "now", current: true },
      { id: "d42e91b", subject: "Define local-first v1 contracts", relativeTime: "22m" },
      { id: "8a7c10f", subject: "Add native workspace scaffold", relativeTime: "41m" },
      { id: "2c18fd4", subject: "Initialize product specification", relativeTime: "2h" },
    ],
  };

  return {
    projects,
    tasks,
    activeTaskId: "v1-shell",
    activeProjectId: "integrator",
    runtimes,
    transcript,
    children,
    usage,
    git,
  };
}
