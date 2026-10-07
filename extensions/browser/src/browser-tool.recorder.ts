/**
 * Browser page-read recorder.
 *
 * Off by default. When `browser.recorder.enabled` is set, each page read the
 * model receives is also written whole under `<stateDir>/recorder/` beside its
 * cut copy; the model-facing result is unchanged apart from `details.recorder`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger, redactSensitiveFieldValue } from "openclaw/plugin-sdk/logging-core";
import {
  formatErrorMessage,
  truncateSanitizedExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { browserRecorderCapture, getRuntimeConfig } from "./browser-tool.runtime.js";
import { readRoleSnapshotLineIdentity } from "./browser/pw-role-snapshot.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";

const logger = createSubsystemLogger("browser");
const RECORDER_DIR = "recorder";
const RECEIVED_FILE = "received.txt";

export type BrowserRecorderSettings = {
  enabled: boolean;
  /** Page-text ceiling for one snapshot or text result; undefined keeps the tool's default. */
  capChars?: number;
};

export function resolveBrowserRecorderSettings(): BrowserRecorderSettings {
  const recorder = getRuntimeConfig().browser?.recorder;
  return {
    enabled: recorder?.enabled === true,
    ...(typeof recorder?.capChars === "number" ? { capChars: recorder.capChars } : {}),
  };
}

/** The `details.recorder` block a recorded result carries; `dir` is relative to the state dir. */
export type BrowserRecorderDetails = {
  dir: string;
  received_chars: number;
  total_chars: number;
  truncated: boolean;
};

type RecorderBoxEntry =
  | { x: number; y: number; w: number; h: number; role: string; name?: string }
  | { role: string; name?: string; box: null };

/** The whole read as the model would see it uncut: same neutralizing and sanitizing, no budget. */
export function recorderOutline(untruncated: string): string {
  const value = neutralizeMediaDirectives(untruncated);
  return truncateSanitizedExternalContent(value, value.length).text;
}

/** How many leading characters of the outline the model's copy carries. */
export function receivedPrefixChars(received: string, outline: string): number {
  const limit = Math.min(received.length, outline.length);
  let index = 0;
  while (index < limit && received.charCodeAt(index) === outline.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function outlineRefs(outline: string): Map<string, { role: string; name?: string }> {
  const refs = new Map<string, { role: string; name?: string }>();
  for (const line of outline.split("\n")) {
    const identity = readRoleSnapshotLineIdentity(line);
    if (identity && !refs.has(identity.ref)) {
      refs.set(identity.ref, {
        role: identity.role,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
      });
    }
  }
  return refs;
}

function redactArgs(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return key ? redactSensitiveFieldValue(key, value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactArgs(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, redactArgs(entry, entryKey)]),
    );
  }
  return value;
}

async function allocateCaptureDir(root: string, action: string) {
  await fs.mkdir(root, { recursive: true });
  const taken = (await fs.readdir(root))
    .map((name) => Number.parseInt(name.slice(0, name.indexOf("-")), 10))
    .filter((n) => Number.isSafeInteger(n));
  let n = taken.length ? Math.max(...taken) + 1 : 1;
  // Concurrent reads in one state dir race for the same number; mkdir is the arbiter.
  for (;;) {
    const name = `${String(n).padStart(4, "0")}-${action}`;
    try {
      await fs.mkdir(path.join(root, name));
      return { n, name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      n += 1;
    }
  }
}

async function moveFile(from: string, to: string) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      throw err;
    }
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

/**
 * Write one capture directory for a page read the model just received.
 * Never fails the tool call: a capture error is logged and the result goes out
 * without `details.recorder`.
 */
export async function recordPageRead(params: {
  action: string;
  args: Record<string, unknown>;
  untruncated: string;
  received: string;
  /**
   * Set when the model's copy is a selection from the read (a snapshot query, a text
   * selector) rather than a prefix of it; `truncated` says whether that copy or the
   * page it was selected from was cut.
   */
  filtered?: { truncated: boolean };
  capChars: number;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  signal?: AbortSignal;
}): Promise<BrowserRecorderDetails | undefined> {
  try {
    const outline = recorderOutline(params.untruncated);
    const receivedChars = params.filtered
      ? params.received.length
      : receivedPrefixChars(params.received, outline);
    const refs = outlineRefs(outline);
    const capture = await browserRecorderCapture(params.baseUrl, {
      targetId: params.targetId,
      profile: params.profile,
      signal: params.signal,
      refs: [...refs.keys()],
    });
    const root = path.join(resolveStateDir(process.env), RECORDER_DIR);
    const { n, name } = await allocateCaptureDir(root, params.action);
    const dir = path.join(root, name);
    const boxes: Record<string, RecorderBoxEntry> = {};
    for (const [ref, identity] of refs) {
      const box = capture.boxes[ref];
      boxes[ref] = box ? { ...box, ...identity } : { ...identity, box: null };
    }
    const details: BrowserRecorderDetails = {
      dir: `${RECORDER_DIR}/${name}`,
      received_chars: receivedChars,
      total_chars: outline.length,
      truncated: params.filtered ? params.filtered.truncated : receivedChars < outline.length,
    };
    const meta = {
      n,
      ts: new Date().toISOString(),
      action: params.action,
      url: capture.url,
      title: capture.title,
      cap_chars: params.capChars,
      received_chars: details.received_chars,
      total_chars: details.total_chars,
      truncated: details.truncated,
      viewport: capture.viewport,
      page: capture.page,
      args: redactArgs(params.args),
      ...(params.filtered ? { received: RECEIVED_FILE } : {}),
    };
    await Promise.all([
      fs.writeFile(path.join(dir, "outline.txt"), outline),
      ...(params.filtered ? [fs.writeFile(path.join(dir, RECEIVED_FILE), params.received)] : []),
      fs.writeFile(
        path.join(dir, "boxes.json"),
        `${JSON.stringify({ url: capture.url, refs: boxes }, null, 1)}\n`,
      ),
      fs.writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 1)}\n`),
      moveFile(capture.path, path.join(dir, "page.png")),
    ]);
    return details;
  } catch (err) {
    params.signal?.throwIfAborted();
    logger.warn(
      `browser recorder: capture failed for ${params.action}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
