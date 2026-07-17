import type { IntegratorSkillInfo } from "./bridge";

/** Written through the standard settings path; the native host reads the
 * persisted `settings.`-prefixed key when filtering discovery and building
 * the per-turn projection. */
export const SKILLS_ENABLED_KEY = "skills.integrator.enabled";

export type SkillEnablementMap = Record<string, boolean>;

export function readSkillEnablement(value: unknown): SkillEnablementMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const map: SkillEnablementMap = {};
  for (const [name, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof enabled === "boolean") map[name] = enabled;
  }
  return map;
}

/** Explicit overrides only; a toggle back to the default is stored anyway so
 * the user's decision survives future default changes. */
export function withSkillEnablement(
  map: SkillEnablementMap,
  name: string,
  enabled: boolean,
): SkillEnablementMap {
  return { ...map, [name]: enabled };
}

/** Apply one plugin-level decision without erasing the child overrides for
 * any other plugin. Individual skill switches can still refine the result.
 * Structural over `{ name }` so the same cascade applies to a plugin's MCP
 * servers, not just its skills. */
export function withSkillsEnablement(
  map: SkillEnablementMap,
  items: Array<{ name: string }>,
  enabled: boolean,
): SkillEnablementMap {
  const next = { ...map };
  for (const item of items) next[item.name] = enabled;
  return next;
}

export function isSkillEnabled(map: SkillEnablementMap, skill: IntegratorSkillInfo): boolean {
  // `enabled` is the host's authoritative persisted value. The renderer map
  // wins immediately after a local toggle while that write settles.
  return map[skill.name] ?? skill.enabled;
}

/** Group inventory rows for display: standalone user skills first, then one
 * group per plugin namespace. */
export function groupSkills(
  skills: IntegratorSkillInfo[],
): Array<{ title: string; source: string; skills: IntegratorSkillInfo[] }> {
  const groups = new Map<
    string,
    { title: string; source: string; skills: IntegratorSkillInfo[] }
  >();
  for (const skill of skills) {
    const namespace = skill.name.includes(":") ? skill.name.split(":", 1)[0] : skill.name;
    const key = `${skill.source}:${namespace}`;
    const title = namespace === "integrator" ? "My skills" : namespace;
    const group = groups.get(key) ?? { title, source: skill.source, skills: [] };
    group.skills.push(skill);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const rank = (source: string) => (source === "integrator" ? 0 : source === "plugin" ? 1 : 2);
    return rank(a.source) - rank(b.source) || a.title.localeCompare(b.title);
  });
}

/** Curated one-click installs: official skill packs published by the labs
 * and vendors themselves. Every entry was verified to exist and to contain
 * SKILL.md skills (2026-07). `icon` is a semantic key the Settings UI maps
 * to an audited, locally bundled mark from the publisher's official URL. */
export interface CuratedPluginInstall {
  repository: string;
  /** Verified against the repository tree, 2026-07. */
  skillCount: number;
  mcpCount: number;
  license?: string;
  label: string;
  description: string;
  icon: string;
}

export const CURATED_PLUGIN_INSTALLS: CuratedPluginInstall[] = [
  {
    repository: "anthropics/skills",
    skillCount: 18,
    mcpCount: 0,
    label: "Anthropic skills",
    description:
      "Anthropic's official catalog, including the claude-api documentation skill and document tooling (Apache-2.0 examples).",
    icon: "anthropic",
  },
  {
    repository: "openai/skills",
    skillCount: 44,
    mcpCount: 0,
    label: "OpenAI Codex skills",
    description: "OpenAI's official skills catalog for Codex — 40+ skills.",
    icon: "openai",
  },
  {
    repository: "firebase/agent-skills",
    license: "Apache-2.0",
    skillCount: 11,
    mcpCount: 2,
    label: "Firebase agent skills",
    description:
      "Firebase's official pack for Auth, Firestore, Security Rules, Hosting, App Hosting, Crashlytics, and local development.",
    icon: "firebase",
  },
  {
    repository: "google/skills",
    license: "Apache-2.0",
    skillCount: 78,
    mcpCount: 0,
    label: "Google agent skills",
    description:
      "Google's official catalog for Google Cloud, Gemini APIs, managed agents, databases, Firebase basics, and architecture guidance.",
    icon: "google",
  },
  {
    repository: "googleworkspace/cli",
    license: "Apache-2.0",
    skillCount: 95,
    mcpCount: 0,
    label: "Google Workspace skills",
    description:
      "Google's official Gmail, Drive, Calendar, Docs, Sheets, Chat, and cross-service workflow skills, paired with the gws CLI.",
    icon: "google-drive",
  },
  {
    repository: "supabase/agent-skills",
    license: "MIT",
    skillCount: 2,
    mcpCount: 1,
    label: "Supabase agent skills",
    description:
      "Supabase's official skills for Postgres, Row Level Security, Auth, Edge Functions, and production database practices.",
    icon: "supabase",
  },
  {
    repository: "vercel-labs/agent-skills",
    skillCount: 9,
    mcpCount: 0,
    label: "Vercel agent skills",
    description: "Vercel's official pack covering deployment and framework guidance.",
    icon: "vercel",
  },
  {
    repository: "cloudflare/skills",
    license: "Apache-2.0",
    skillCount: 11,
    mcpCount: 0,
    label: "Cloudflare skills",
    description:
      "Official skills for building on Workers, R2, D1, and the Cloudflare platform (Apache-2.0).",
    icon: "cloudflare",
  },
  {
    repository: "microsoft/skills",
    license: "MIT",
    skillCount: 191,
    mcpCount: 0,
    label: "Microsoft skills",
    description: "Microsoft's catalog grounding agents in their SDKs — nearly 200 skills (MIT).",
    icon: "microsoft",
  },
  {
    repository: "huggingface/skills",
    license: "Apache-2.0",
    skillCount: 26,
    mcpCount: 0,
    label: "Hugging Face skills",
    description:
      "Official skills for the Hugging Face ecosystem — models, datasets, and inference (Apache-2.0).",
    icon: "huggingface",
  },
  {
    repository: "nvidia/skills",
    license: "Custom",
    skillCount: 242,
    mcpCount: 0,
    label: "NVIDIA agent skills",
    description:
      "NVIDIA-verified skills for CUDA-X libraries, accelerated computing, optimization, and AI infrastructure.",
    icon: "nvidia",
  },
  {
    repository: "expo/skills",
    license: "MIT",
    skillCount: 22,
    mcpCount: 0,
    label: "Expo skills",
    description: "Official skills for Expo apps and Expo Application Services (MIT).",
    icon: "mobile",
  },
  {
    repository: "stripe/ai",
    license: "MIT",
    skillCount: 19,
    mcpCount: 0,
    label: "Stripe AI toolkit",
    description: "Stripe's official pack for building payment flows with agents (MIT).",
    icon: "stripe",
  },
  {
    repository: "remotion-dev/skills",
    skillCount: 17,
    mcpCount: 0,
    label: "Remotion skills",
    description: "Official skills for programmatic video with Remotion.",
    icon: "video",
  },
  {
    repository: "obra/superpowers",
    license: "MIT",
    skillCount: 14,
    mcpCount: 0,
    label: "Superpowers",
    description: "The popular community skills framework for software engineering workflows (MIT).",
    icon: "community",
  },
];
