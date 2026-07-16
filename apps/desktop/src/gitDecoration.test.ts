import { describe, expect, it } from "vitest";
import {
  CO_AUTHOR_TRAILER,
  DEFAULT_COMMIT_PREFIX,
  decorateCommitMessage,
  GIT_SETTINGS,
  readGitDecorationSettings,
  readPushForce,
  type GitDecorationSettings,
} from "./gitDecoration";

const off: GitDecorationSettings = {
  coAuthor: false,
  commitPrefixEnabled: false,
  commitPrefix: DEFAULT_COMMIT_PREFIX,
};

describe("commit decoration", () => {
  it("changes nothing until a decoration is turned on", () => {
    expect(decorateCommitMessage("fix the parser panic", off)).toBe("fix the parser panic");
  });

  it("defaults every decoration off, because each one edits permanent history", () => {
    const settings = readGitDecorationSettings({});
    expect(settings.coAuthor).toBe(false);
    expect(settings.commitPrefixEnabled).toBe(false);
    expect(settings.commitPrefix).toBe(DEFAULT_COMMIT_PREFIX);
    expect(readPushForce({})).toBe("off");
  });

  it("prefixes the subject and appends the trailer after a blank line", () => {
    const decorated = decorateCommitMessage("fix the parser panic", {
      ...off,
      coAuthor: true,
      commitPrefixEnabled: true,
    });
    expect(decorated).toBe(
      `${DEFAULT_COMMIT_PREFIX} fix the parser panic\n\n${CO_AUTHOR_TRAILER}`,
    );
  });

  it("separates the trailer from a subject that is itself trailer-shaped", () => {
    // The default prefix ends in a colon, so the subject looks exactly like a
    // trailer. Without a blank line Git would read the subject as part of the
    // trailer block and the commit would have no subject at all.
    const decorated = decorateCommitMessage("ai-integrator-push: fix it", {
      ...off,
      coAuthor: true,
    });
    expect(decorated).toBe(`ai-integrator-push: fix it\n\n${CO_AUTHOR_TRAILER}`);
  });

  it("joins an existing trailer block rather than orphaning the new trailer", () => {
    // Git only reads trailers from the last paragraph, so a second blank line
    // here would push the existing Signed-off-by out of the block.
    const decorated = decorateCommitMessage(
      "fix the parser panic\n\nSigned-off-by: Luke <luke@example.invalid>",
      { ...off, coAuthor: true },
    );
    expect(decorated).toBe(
      `fix the parser panic\n\nSigned-off-by: Luke <luke@example.invalid>\n${CO_AUTHOR_TRAILER}`,
    );
  });

  it("is idempotent, so an edited retry never grows a second prefix or trailer", () => {
    const settings = { ...off, coAuthor: true, commitPrefixEnabled: true };
    const once = decorateCommitMessage("fix the parser panic", settings);
    expect(decorateCommitMessage(once, settings)).toBe(once);
  });

  it("keeps a body between the subject and the trailer", () => {
    const decorated = decorateCommitMessage("subject\n\nthe body explains why", {
      ...off,
      coAuthor: true,
    });
    expect(decorated).toBe(`subject\n\nthe body explains why\n\n${CO_AUTHOR_TRAILER}`);
  });

  it("ignores an enabled-but-blank prefix instead of prepending whitespace", () => {
    expect(
      decorateCommitMessage("subject", { ...off, commitPrefixEnabled: true, commitPrefix: "   " }),
    ).toBe("subject");
  });

  it("leaves an empty message empty so the native length check still fires", () => {
    expect(decorateCommitMessage("   ", { ...off, coAuthor: true })).toBe("");
  });
});

describe("push force", () => {
  it("reads only the modes the native side accepts", () => {
    expect(readPushForce({ [GIT_SETTINGS.forcePush]: "lease" })).toBe("lease");
    expect(readPushForce({ [GIT_SETTINGS.forcePush]: "always" })).toBe("always");
  });

  it("falls back to off for anything unrecognized, never to a forcing mode", () => {
    expect(readPushForce({ [GIT_SETTINGS.forcePush]: "yes" })).toBe("off");
    expect(readPushForce({ [GIT_SETTINGS.forcePush]: true })).toBe("off");
    expect(readPushForce({ [GIT_SETTINGS.forcePush]: null })).toBe("off");
  });
});
