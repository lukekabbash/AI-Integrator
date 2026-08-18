import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bridge } from "../bridge";
import { MarkdownImage } from "./MarkdownImage";

const captureImage = vi.fn();

beforeEach(() => {
  captureImage.mockReset();
  (bridge as { browser?: unknown }).browser = { captureImage };
});

describe("MarkdownImage", () => {
  it("draws an app-owned capture the agent named in its reply", async () => {
    captureImage.mockResolvedValue("data:image/png;base64,AAAA");
    render(<MarkdownImage src="/data/browser-captures/task-1/shot.png" alt="screenshot" />);

    const image = await screen.findByAltText("screenshot");
    expect(image).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(captureImage).toHaveBeenCalledWith("/data/browser-captures/task-1/shot.png");
  });

  it("draws an inline data URL without asking the native side", () => {
    render(<MarkdownImage src="data:image/png;base64,BBBB" alt="inline" />);

    expect(screen.getByAltText("inline")).toHaveAttribute("src", "data:image/png;base64,BBBB");
    expect(captureImage).not.toHaveBeenCalled();
  });

  it("never fetches a remote address", () => {
    render(<MarkdownImage src="https://example.test/tracker.png" alt="remote" />);

    expect(screen.queryByAltText("remote")).not.toBeInTheDocument();
    expect(screen.getByTitle("https://example.test/tracker.png")).toBeInTheDocument();
    expect(captureImage).not.toHaveBeenCalled();
  });

  it("says so when the file is refused rather than leaving a hole", async () => {
    captureImage.mockRejectedValue(new Error("that file is not one of this app's captures"));
    render(<MarkdownImage src="/home/me/.ssh/id_rsa.png" alt="denied" />);

    await waitFor(() =>
      expect(screen.getByTitle("/home/me/.ssh/id_rsa.png")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
