// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SEARCH_ENGINES } from "../browserOmnibox";
import { toggleBrowserBookmark } from "./browserBookmarks";
import { rememberBrowserVisit } from "./browserRecents";
import { BrowserOmnibox } from "./BrowserOmnibox";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("BrowserOmnibox", () => {
  it("submits a search URL for a phrase", () => {
    const onSubmit = vi.fn();
    render(<BrowserOmnibox value="how to center a div" onChange={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(SEARCH_ENGINES.google.searchUrl("how to center a div"));
  });

  it("submits a typed host as an address", () => {
    const onSubmit = vi.fn();
    render(<BrowserOmnibox value="github.com" onChange={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("github.com");
  });

  it("lists a matching bookmark as a suggestion", () => {
    toggleBrowserBookmark("https://github.com", "GitHub");
    render(<BrowserOmnibox value="git" onChange={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.focus(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: /GitHub/ })).toBeInTheDocument();
  });

  it("stays quiet on an empty focus and lists recents on an arrow key", () => {
    rememberBrowserVisit("https://linear.app", "Linear");
    render(<BrowserOmnibox value="" onChange={vi.fn()} onSubmit={vi.fn()} />);

    const field = screen.getByRole("combobox");
    fireEvent.focus(field);
    expect(screen.queryByRole("option", { name: /Linear/ })).not.toBeInTheDocument();

    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Linear/ })).toBeInTheDocument();
  });

  it("clears the draft without leaving the field", () => {
    const onChange = vi.fn();
    render(<BrowserOmnibox value="flexbox" onChange={onChange} onSubmit={vi.fn()} />);

    // A resting address shows no clear control; typing (focus) reveals it.
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith("");
  });
});
