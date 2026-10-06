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

  it("keeps the tool result when the capture fails", async () => {
    enableRecorder();
    actions.browserRecorderCapture.mockRejectedValueOnce(new Error("page closed"));

    const result = await execute({ action: "snapshot", targetId: "t1" });

    expect(result.details).not.toHaveProperty("recorder");
    expect(resultText(result)).toContain("Product 1");
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
