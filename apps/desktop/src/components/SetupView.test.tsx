import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeConnection } from "../bridge";
import { SetupView } from "./SetupView";

const runtime = (detail: string): RuntimeConnection => ({
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  version: "test",
  status: "degraded",
  fidelity: "acp",
  models: [],
  detail,
});

function renderSetup(detail: string, onRuntimeAction = vi.fn()) {
  render(
    <SetupView
      runtimes={[runtime(detail)]}
      onBack={vi.fn()}
      onRuntimeAction={onRuntimeAction}
      onCreateProject={vi.fn()}
      onFinish={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Set up my runtimes/i }));
  return onRuntimeAction;
}

describe("SetupView runtime recovery", () => {
  it("offers vendor sign-in when an installed runtime's auth probe is inconclusive", async () => {
    const onRuntimeAction = renderSetup("auth-status-unknown");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(onRuntimeAction).toHaveBeenCalledWith("cursor", "login");
  });

  it("keeps capability degradation on the update review route", async () => {
    const onRuntimeAction = renderSetup("capability-mismatch");

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(onRuntimeAction).toHaveBeenCalledWith("cursor", "update");
  });
});
