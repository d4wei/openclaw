import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "./browser-tool.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import { receivedPrefixChars, recorderOutline } from "./browser-tool.recorder.js";

const {
  browserClientMocks: client,
  browserActionsMocks: actions,
  configMocks: config,
  resetBrowserToolMocks,
} = await import("./browser-tool.test-support.js");

const OUTLINE_LINES = Array.from(
  { length: 900 },
  (_, index) => `- link "Product ${index + 1} with a long descriptive name" [ref=e${index + 1}]`,
);
const OUTLINE = OUTLINE_LINES.join("\n");

let stateDir: string;

/** The lines a snapshot query keeps: every whitespace token appears, case-insensitively. */
function queryMatches(lines: string[], query: string) {
  const tokens = query.toLowerCase().split(/\s+/);
  return lines.filter((line) => tokens.every((token) => line.toLowerCase().includes(token)));
}

function execute(input: Record<string, unknown>) {
  return createBrowserTool().execute("call-1", input);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((block) => block.text ?? "").join("\n");
}

function withoutEnvelopeIds(text: string) {
  return text.replace(/id="[^"]*"/g, 'id=""');
}

function innerPageText(text: string) {
  const start = text.indexOf("---\n") + 4;
  return text.slice(start, text.indexOf("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT", start));
}

async function readCapture(dir: string) {
  const root = path.join(stateDir, dir);
  return {
    outline: await fs.readFile(path.join(root, "outline.txt"), "utf8"),
    boxes: JSON.parse(await fs.readFile(path.join(root, "boxes.json"), "utf8")),
    meta: JSON.parse(await fs.readFile(path.join(root, "meta.json"), "utf8")),
    png: await fs.readFile(path.join(root, "page.png")),
    received: await fs.readFile(path.join(root, "received.txt"), "utf8").catch(() => undefined),
    outlineFull: await fs
      .readFile(path.join(root, "outline-full.txt"), "utf8")
      .catch(() => undefined),
  };
}

function enableRecorder(recorder: Record<string, unknown> = { enabled: true }) {
  config.loadConfig.mockReturnValue({ browser: { recorder } });
}

beforeEach(async () => {
  resetBrowserToolMocks();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recorder-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  client.browserSnapshot.mockResolvedValue({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://shop.example/",
    snapshot: OUTLINE,
  });
  actions.browserRecorderCapture.mockImplementation(async (...args: unknown[]) => {
    const { refs } = args[1] as { refs: string[] };
    const png = path.join(stateDir, `capture-${Math.random()}.png`);
    await fs.writeFile(png, "png-bytes");
    return {
      ok: true,
      targetId: "t1",
      url: "https://shop.example/",
      title: "Shop",
      viewport: { w: 1280, h: 720 },
      page: { w: 1280, h: 20_000 },
      boxes: Object.fromEntries(
        refs.map((ref, index) => [
          ref,
          index === 1 ? null : { x: 0, y: index * 20, w: 100, h: 18 },
        ]),
      ),
      path: png,
    };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetBrowserToolMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("browser recorder", () => {
  it("leaves the snapshot result and request untouched when disabled", async () => {
    const result = await execute({ action: "snapshot", targetId: "t1" });

    expect(client.browserSnapshot.mock.calls[0]?.[1]).not.toHaveProperty("recorder");
    expect(actions.browserRecorderCapture).not.toHaveBeenCalled();
    expect(result.details).not.toHaveProperty("recorder");
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  });

  it("records the whole outline while the model keeps its cut copy", async () => {
    const plain = await execute({ action: "snapshot", targetId: "t1" });
    enableRecorder();
    const recorded = await execute({ action: "snapshot", targetId: "t1" });

    expect(withoutEnvelopeIds(resultText(recorded))).toBe(withoutEnvelopeIds(resultText(plain)));
    expect(client.browserSnapshot.mock.calls[1]?.[1]).toMatchObject({ recorder: true });
    const details = recorded.details as { recorder: Record<string, unknown> };
    expect(details.recorder).toMatchObject({
      dir: "recorder/0001-snapshot",
      total_chars: OUTLINE.length,
      truncated: true,
    });
    const capture = await readCapture("recorder/0001-snapshot");
    expect(capture.outline).toBe(OUTLINE);
    const received = innerPageText(resultText(recorded));
    const receivedChars = details.recorder.received_chars as number;
    expect(receivedChars).toBeGreaterThan(1000);
    expect(receivedChars).toBeLessThan(16_000);
    expect(received.slice(0, receivedChars)).toBe(OUTLINE.slice(0, receivedChars));
    expect(Object.keys(capture.boxes.refs)).toHaveLength(OUTLINE_LINES.length);
    expect(capture.boxes.refs.e1).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 18,
      role: "link",
      name: "Product 1 with a long descriptive name",
    });
    expect(capture.boxes.refs.e2).toEqual({
      role: "link",
      name: "Product 2 with a long descriptive name",
      box: null,
    });
    expect(capture.meta).toMatchObject({
      n: 1,
      action: "snapshot",
      url: "https://shop.example/",
      title: "Shop",
      received_chars: receivedChars,
      total_chars: OUTLINE.length,
      truncated: true,
      viewport: { w: 1280, h: 720 },
      page: { w: 1280, h: 20_000 },
      args: { action: "snapshot", targetId: "t1" },
    });
    expect(capture.meta.cap_chars).toBeLessThan(16_000);
    expect(capture.png.toString()).toBe("png-bytes");
    expect(capture.received).toBeUndefined();
    expect(capture.meta).not.toHaveProperty("received");
    expect(capture.outlineFull).toBeUndefined();
    expect(capture.meta).not.toHaveProperty("outline_full");
  });

  it("writes the full tree beside a narrowed outline and boxes the refs of both", async () => {
    enableRecorder();
    const narrowed = OUTLINE_LINES.slice(0, 3).join("\n");
    const full = [
      '- heading "Results" [ref=e901]',
      ...OUTLINE_LINES.slice(0, 3),
      '- paragraph "Gentle on skin" [ref=e902]',
    ].join("\n");
    client.browserSnapshot.mockResolvedValueOnce({
      ok: true,
      format: "ai",
      targetId: "t1",
      url: "https://shop.example/",
      snapshot: narrowed,
      recorder: { untruncatedSnapshot: undefined, fullSnapshot: full, fullNodes: { e902: 77 } },
    });

    const result = await execute({ action: "snapshot", targetId: "t1", mode: "efficient" });
    const capture = await readCapture("recorder/0001-snapshot");

    expect(capture.outline).toBe(narrowed);
    expect(capture.outlineFull).toBe(full);
    expect(capture.meta).toMatchObject({
      outline_full: "outline-full.txt",
      total_chars: narrowed.length,
      truncated: false,
      args: { mode: "efficient" },
    });
    expect(result.details).toMatchObject({
      recorder: { received_chars: narrowed.length, total_chars: narrowed.length },
    });
    expect(actions.browserRecorderCapture.mock.calls[0]?.[1]).toMatchObject({
      refs: ["e1", "e2", "e3", "e901", "e902"],
      nodes: { e902: 77 },
    });
    expect(Object.keys(capture.boxes.refs)).toEqual(["e1", "e2", "e3", "e901", "e902"]);
    expect(capture.boxes.refs.e902).toMatchObject({ role: "paragraph", name: "Gentle on skin" });
  });

  it("captures a query-filtered snapshot from the whole outline, its matches beside it", async () => {
    enableRecorder();
    const result = await execute({ action: "snapshot", targetId: "t1", query: "product 17 with" });
    const capture = await readCapture("recorder/0001-snapshot");
    const matched = queryMatches(OUTLINE_LINES, "product 17 with");
    const matches = matched.join("\n");

    expect(capture.outline).toBe(OUTLINE);
    expect(capture.received).toBe(matches);
    expect(innerPageText(resultText(result))).toBe(matches);
    expect(result.details).toMatchObject({
      matchCount: matched.length,
      recorder: {
        dir: "recorder/0001-snapshot",
        received_chars: matches.length,
        total_chars: OUTLINE.length,
        truncated: false,
      },
    });
    expect(capture.meta).toMatchObject({
      received: "received.txt",
      received_chars: matches.length,
      total_chars: OUTLINE.length,
      truncated: false,
      args: { action: "snapshot", query: "product 17 with" },
    });
    expect(Object.keys(capture.boxes.refs)).toHaveLength(OUTLINE_LINES.length);
  });

  it("marks a filtered capture truncated when the page it filtered was cut", async () => {
    enableRecorder();
    const cut = OUTLINE_LINES.slice(0, 50).join("\n");
    client.browserSnapshot.mockResolvedValueOnce({
      ok: true,
      format: "ai",
      targetId: "t1",
      url: "https://shop.example/",
      snapshot: cut,
      truncated: true,
      recorder: { maxChars: 4000, untruncatedSnapshot: OUTLINE },
    });

    const result = await execute({ action: "snapshot", targetId: "t1", query: "product 7 with" });
    const capture = await readCapture("recorder/0001-snapshot");

    expect(capture.outline).toBe(OUTLINE);
    expect(capture.received).toBe(
      queryMatches(OUTLINE_LINES.slice(0, 50), "product 7 with").join("\n"),
    );
    expect((result.details as { recorder: { truncated: boolean } }).recorder.truncated).toBe(true);
  });

  it("uses the service's uncut outline and reports the tighter cap", async () => {
    enableRecorder();
    const cut = OUTLINE_LINES.slice(0, 50).join("\n");
    client.browserSnapshot.mockResolvedValueOnce({
      ok: true,
      format: "ai",
      targetId: "t1",
      url: "https://shop.example/",
      snapshot: `${cut}\n\n[...TRUNCATED - page too large]`,
      truncated: true,
      recorder: { maxChars: 4000, untruncatedSnapshot: OUTLINE },
    });

    const result = await execute({ action: "snapshot", targetId: "t1", maxChars: 4000 });
    const capture = await readCapture("recorder/0001-snapshot");

    expect(capture.outline).toBe(OUTLINE);
    expect(capture.meta.cap_chars).toBe(4000);
    expect(
      (result.details as { recorder: { received_chars: number } }).recorder.received_chars,
    ).toBe(cut.length + 1);
  });

  it("applies capChars to the model's copy", async () => {
    enableRecorder({ enabled: true, capChars: 2000 });
    const result = await execute({ action: "snapshot", targetId: "t1" });
    const inner = innerPageText(resultText(result));

    expect(inner.length).toBeLessThanOrEqual(2000);
    expect(
      (result.details as { recorder: { received_chars: number } }).recorder.received_chars,
    ).toBeLessThanOrEqual(2000);
    expect((await readCapture("recorder/0001-snapshot")).meta.cap_chars).toBe(2000);
  });

  it("links the page state of a navigation from the navigate result", async () => {
    enableRecorder();
    actions.browserNavigate.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://shop.example/",
    });

    const result = await execute({ action: "navigate", url: "https://shop.example/" });
    const details = result.details as { recorder?: { dir: string }; pageState?: object };

    expect(details.recorder?.dir).toBe("recorder/0001-navigate");
    expect(details.pageState).not.toHaveProperty("recorder");
    expect((await readCapture("recorder/0001-navigate")).meta.args).toMatchObject({
      action: "navigate",
      url: "https://shop.example/",
    });
  });

  it("records page text and numbers captures past existing ones", async () => {
    enableRecorder();
    await fs.mkdir(path.join(stateDir, "recorder", "0007-snapshot"), { recursive: true });
    actions.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://shop.example/",
      text: "Free shipping",
      truncated: true,
      untruncatedText: "Free shipping on orders over $50",
    });

    const result = await execute({ action: "text", targetId: "t1" });

    expect(actions.browserPageText.mock.calls[0]?.[1]).toMatchObject({ recorder: true });
    expect(result.details).toMatchObject({
      recorder: {
        dir: "recorder/0008-text",
        received_chars: "Free shipping".length,
        total_chars: "Free shipping on orders over $50".length,
        truncated: true,
      },
    });
    const capture = await readCapture("recorder/0008-text");
    expect(capture.outline).toBe("Free shipping on orders over $50");
    expect(capture.boxes).toEqual({ url: "https://shop.example/", refs: {} });
  });

  it("captures a selector text read from the unselected page, its text beside it", async () => {
    enableRecorder();
    actions.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      url: "https://shop.example/",
      text: "Over $50",
      truncated: false,
      unfilteredText: "Free shipping\nOver $50",
    });

    const result = await execute({ action: "text", targetId: "t1", selector: ".promo" });
    const capture = await readCapture("recorder/0001-text");

    expect(capture.outline).toBe("Free shipping\nOver $50");
    expect(capture.received).toBe("Over $50");
    expect(result.details).toMatchObject({
      recorder: { received_chars: 8, total_chars: 22, truncated: false },
    });
    expect(capture.meta).toMatchObject({
      received: "received.txt",
      args: { action: "text", selector: ".promo" },
    });
  });

  it("keeps the tool result when the capture fails", async () => {
    enableRecorder();
    actions.browserRecorderCapture.mockRejectedValueOnce(new Error("page closed"));

    const result = await execute({ action: "snapshot", targetId: "t1" });

    expect(result.details).not.toHaveProperty("recorder");
    expect(resultText(result)).toContain("Product 1");
  });
});

describe("browser recorder act results", () => {
  const ERROR_DETAILS = Symbol.for("openclaw.toolErrorDetails");
  const click = { action: "act", request: { kind: "click", ref: "e5", targetId: "t1" } };

  async function failure(input: Record<string, unknown>) {
    try {
      await execute(input);
    } catch (error) {
      return error as Error & { [ERROR_DETAILS]?: unknown };
    }
    throw new Error("the act did not fail");
  }

  it("records how long a successful act took", async () => {
    enableRecorder();
    actions.browserAct.mockResolvedValueOnce({ ok: true, targetId: "t1" });

    const result = await execute(click);
    const act = (result.details as { recorder: { act: { elapsed_ms: number } } }).recorder.act;

    expect(act).toEqual({ elapsed_ms: expect.any(Number) });
    expect(act.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(result.details).not.toHaveProperty("recorder.dir");
    expect(actions.browserRecorderHitTest).not.toHaveBeenCalled();
  });

  it("records a failed act's error, the element covering its target and the time lost", async () => {
    enableRecorder();
    const covered = {
      role: "dialog",
      name: "Sign up for 10% off",
      ref: "e40",
      box: { x: 0, y: 0, w: 1280, h: 720 },
    };
    actions.browserAct.mockRejectedValueOnce(
      new Error('<div class="modal"> intercepts pointer events'),
    );
    actions.browserRecorderHitTest.mockResolvedValueOnce({ ok: true, targetId: "t1", covered });

    const error = await failure(click);

    expect(error.message).toBe('<div class="modal"> intercepts pointer events');
    expect(error[ERROR_DETAILS]).toEqual({
      recorder: {
        act: {
          error: '<div class="modal"> intercepts pointer events',
          covered,
          elapsed_ms: expect.any(Number),
        },
      },
    });
    expect(actions.browserRecorderHitTest.mock.calls[0]?.[1]).toMatchObject({
      targetId: "t1",
      ref: "e5",
    });
  });

  it("records a failed act without a covering element when the hit-test finds none", async () => {
    enableRecorder();
    actions.browserAct.mockRejectedValueOnce(new Error('Unknown ref "e5".'));
    actions.browserRecorderHitTest.mockRejectedValueOnce(new Error("hit-test failed"));

    const error = await failure(click);

    expect(error[ERROR_DETAILS]).toEqual({
      recorder: { act: { error: 'Unknown ref "e5".', elapsed_ms: expect.any(Number) } },
    });
  });

  it("leaves act results and failures untouched when disabled", async () => {
    actions.browserAct.mockResolvedValueOnce({ ok: true, targetId: "t1" });
    const result = await execute(click);
    actions.browserAct.mockRejectedValueOnce(new Error("timeout"));
    const error = await failure(click);

    expect(result.details).not.toHaveProperty("recorder");
    expect(Object.getOwnPropertySymbols(error)).not.toContain(ERROR_DETAILS);
    expect(actions.browserRecorderHitTest).not.toHaveBeenCalled();
  });
});

describe("recorder text helpers", () => {
  it("counts the shared prefix in UTF-16 code units", () => {
    expect(receivedPrefixChars("ab🙂c\n[truncated]", "ab🙂cdef")).toBe(5);
  });

  it("neutralizes the outline the same way as the model's copy", () => {
    expect(recorderOutline("plain outline")).toBe("plain outline");
  });
});
