import { describe, expect, it } from "vitest";

import {
  CURATED_MCP_SERVERS,
  mcpActivationWarning,
  mcpLaunchPreview,
  parseMcpForm,
} from "./mcpSettings";

describe("parseMcpForm", () => {
  it("builds a stdio config with split args and env lines", () => {
    const { config, error } = parseMcpForm({
      transport: "stdio",
      command: " npx ",
      args: "-y @upstash/context7-mcp",
      env: "API_KEY=abc\n\nREGION=us-east-1",
      url: "",
    });
    expect(error).toBeUndefined();
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { API_KEY: "abc", REGION: "us-east-1" },
    });
  });

  it("rejects missing commands, malformed env lines, and non-http urls", () => {
    expect(
      parseMcpForm({ transport: "stdio", command: " ", args: "", env: "", url: "" }).error,
    ).toBeTruthy();
    expect(
      parseMcpForm({ transport: "stdio", command: "npx", args: "", env: "not-a-pair", url: "" })
        .error,
    ).toBeTruthy();
    expect(
      parseMcpForm({ transport: "remote", command: "", args: "", env: "", url: "ftp://x" }).error,
    ).toBeTruthy();
    expect(
      parseMcpForm({
        transport: "remote",
        command: "",
        args: "",
        env: "",
        url: "https://x.dev/mcp",
      }).config,
    ).toEqual({ url: "https://x.dev/mcp" });
    expect(
      parseMcpForm({
        transport: "remote",
        command: "",
        args: "",
        env: "",
        url: "https://x.dev/mcp",
        oauth: true,
      }).config,
    ).toEqual({ url: "https://x.dev/mcp", auth: "oauth" });
  });
});

describe("mcpLaunchPreview", () => {
  it("shows the exact command line or url that enabling will run", () => {
    expect(
      mcpLaunchPreview({
        name: "playwright",
        source: "user",
        origin: "MCPs folder",
        enabled: false,
        transport: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest"],
      }),
    ).toBe("npx @playwright/mcp@latest");
    expect(
      mcpLaunchPreview({
        name: "stripe",
        source: "plugin",
        origin: "stripe-ai",
        enabled: false,
        transport: "remote",
        url: "https://mcp.stripe.com",
      }),
    ).toBe("https://mcp.stripe.com");
  });
});

describe("curated MCP authentication", () => {
  it("offers browser sign-in only for servers that advertise an account flow", () => {
    expect(CURATED_MCP_SERVERS.find((server) => server.name === "figma")?.config.auth).toBe(
      "oauth",
    );
    expect(
      CURATED_MCP_SERVERS.find((server) => server.name === "cloudflare-docs")?.config.auth,
    ).toBeUndefined();
  });

  it("pins Robinhood's official OAuth endpoint and trading disclosure", () => {
    expect(CURATED_MCP_SERVERS.find((server) => server.name === "robinhood-trading")).toMatchObject(
      {
        label: "Robinhood Trading",
        icon: "robinhood",
        config: { url: "https://agent.robinhood.com/mcp/trading", auth: "oauth" },
      },
    );
    expect(mcpActivationWarning("robinhood-trading")).toMatchObject({
      confirmLabel: "Enable Robinhood Trading",
      activeLabel: "Real trading enabled",
    });
    expect(mcpActivationWarning("figma")).toBeUndefined();
  });
});
