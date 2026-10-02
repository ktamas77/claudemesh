import { describe, expect, it } from "vitest";
import { renderForBlock } from "../src/hooks/stop.js";
import { renderMessages } from "../src/hooks/user-prompt-submit.js";
import type { InboxMessage } from "../src/shared/types.js";

const sampleTask: InboxMessage = {
  id: "msg_1",
  to: "g7knqn0u",
  from: "pbs83z6q",
  kind: "task",
  body: "rerun the migration check",
  ts: "2026-05-01T00:00:00Z",
};

const sampleNote: InboxMessage = {
  id: "msg_2",
  to: "g7knqn0u",
  from: "pbs83z6q",
  kind: "note",
  body: "fyi: tests pass on main",
  ts: "2026-05-01T00:00:01Z",
};

describe("inbox prompt rendering", () => {
  describe("Stop hook (renderForBlock)", () => {
    it("instructs the recipient to act, not just acknowledge", () => {
      const text = renderForBlock([sampleTask]);
      expect(text).toMatch(/INBOX/);
      expect(text).toMatch(/Perform the work immediately|act on them now/i);
      expect(text).toMatch(/do not merely acknowledge/i);
    });

    it("embeds the message body inside an <inbox-message> tag with from/kind/at attributes", () => {
      const text = renderForBlock([sampleTask]);
      expect(text).toContain(
        '<inbox-message from="pbs83z6q" kind="task" at="2026-05-01T00:00:00Z">',
      );
      expect(text).toContain("rerun the migration check");
      expect(text).toContain("</inbox-message>");
    });

    it("renders both task and note kinds in a single block", () => {
      const text = renderForBlock([sampleTask, sampleNote]);
      expect(text).toContain('kind="task"');
      expect(text).toContain('kind="note"');
      expect(text).toContain("rerun the migration check");
      expect(text).toContain("fyi: tests pass on main");
    });
  });

  describe("UserPromptSubmit hook (renderMessages)", () => {
    it("tells the recipient to process inbox in addition to the user prompt", () => {
      const text = renderMessages([sampleTask]);
      expect(text).toMatch(/in addition to whatever the user typed/i);
    });

    it("uses the same imperative wording for tasks", () => {
      const text = renderMessages([sampleTask]);
      expect(text).toMatch(/Perform the work immediately/i);
      expect(text).toMatch(/do not merely acknowledge/i);
    });

    it("embeds messages with the same <inbox-message> envelope", () => {
      const text = renderMessages([sampleTask]);
      expect(text).toContain(
        '<inbox-message from="pbs83z6q" kind="task" at="2026-05-01T00:00:00Z">',
      );
      expect(text).toContain("rerun the migration check");
      expect(text).toContain("</inbox-message>");
    });
  });
});
