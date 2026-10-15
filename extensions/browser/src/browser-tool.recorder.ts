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
import {
  browserRecorderCapture,
  browserRecorderHitTest,
  browserRecorderLocate,
  getRuntimeConfig,
} from "./browser-tool.runtime.js";
import { readRoleSnapshotLineIdentity } from "./browser/pw-role-snapshot.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";

const logger = createSubsystemLogger("browser");
const RECORDER_DIR = "recorder";
const RECEIVED_FILE = "received.txt";
const OUTLINE_FULL_FILE = "outline-full.txt";
const PAGE_FILE = "page.png";
const META_FILE = "meta.json";
// Core's tool adapter reads this registered symbol (src/agents/tool-error-details.ts) and
// puts the record a failure carries in its error result's details, the error text unchanged.
const TOOL_ERROR_DETAILS = Symbol.for("openclaw.toolErrorDetails");

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

/**
 * The page the newest capture pictured, and the directory holding its image: a capture without
 * an image of its own points at the one it shares through `image_from`.
 */
async function lastPictured(
  root: string,
): Promise<{ url: string; page: { w: number; h: number }; dir: string } | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return undefined;
  }
  const newest = names
    .map((name) => ({ name, n: Number.parseInt(name.slice(0, name.indexOf("-")), 10) }))
    .filter((entry) => Number.isSafeInteger(entry.n))
    .toSorted((a, b) => b.n - a.n)[0];
  if (!newest) {
    return undefined;
  }
  try {
    const meta = JSON.parse(await fs.readFile(path.join(root, newest.name, META_FILE), "utf8")) as {
      url?: unknown;
      page?: { w?: unknown; h?: unknown };
      image_from?: unknown;
    };
    const { url, page } = meta;
    if (typeof url !== "string" || typeof page?.w !== "number" || typeof page?.h !== "number") {
      return undefined;
    }
    const dir = typeof meta.image_from === "string" ? meta.image_from : newest.name;
    await fs.access(path.join(root, dir, PAGE_FILE));
    return { url, page: { w: page.w, h: page.h }, dir };
  } catch {
    return undefined;
  }
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
  /**
   * The full tree read beside a narrowed snapshot mode, in the same refs; `nodes` gives
   * the DOM identity of refs the action cache does not hold, so they can be boxed too.
   */
  full?: { untruncated: string; nodes?: Record<string, number> };
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
    const outlineFull = params.full ? recorderOutline(params.full.untruncated) : undefined;
    // boxes.json covers every ref either outline carries; the model's outline names it first.
    const refs = outlineRefs(outline);
    for (const [ref, identity] of outlineFull ? outlineRefs(outlineFull) : []) {
      if (!refs.has(ref)) {
        refs.set(ref, identity);
      }
    }
    const root = path.join(resolveStateDir(process.env), RECORDER_DIR);
    const last = await lastPictured(root);
    const capture = await browserRecorderCapture(params.baseUrl, {
      targetId: params.targetId,
      profile: params.profile,
      signal: params.signal,
      refs: [...refs.keys()],
      ...(params.full?.nodes ? { nodes: params.full.nodes } : {}),
      ...(last ? { unchanged: { url: last.url, page: last.page } } : {}),
    });
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
      ...(outlineFull !== undefined ? { outline_full: OUTLINE_FULL_FILE } : {}),
      // No image of its own: the page was the one `image_from` pictured, at the same URL and size.
      ...(capture.path === null && last ? { image_from: last.dir } : {}),
    };
    await Promise.all([
      fs.writeFile(path.join(dir, "outline.txt"), outline),
      ...(params.filtered ? [fs.writeFile(path.join(dir, RECEIVED_FILE), params.received)] : []),
      ...(outlineFull !== undefined
        ? [fs.writeFile(path.join(dir, OUTLINE_FULL_FILE), outlineFull)]
        : []),
      fs.writeFile(
        path.join(dir, "boxes.json"),
        `${JSON.stringify({ url: capture.url, refs: boxes }, null, 1)}\n`,
      ),
      fs.writeFile(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 1)}\n`),
      ...(capture.path !== null ? [moveFile(capture.path, path.join(dir, PAGE_FILE))] : []),
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

/** Where one act item's target was on the page before the act ran, in page pixels. */
export type BrowserRecorderTarget = Awaited<
  ReturnType<typeof browserRecorderLocate>
>["targets"][number];

/**
 * The `details.recorder.act` block of an act result: where its targets were, how long the
 * act took and why it failed.
 */
export type BrowserRecorderAct = {
  error?: string;
  covered?: { role: string; name: string; ref?: string; box: object };
  target?: BrowserRecorderTarget;
  targets?: BrowserRecorderTarget[];
  elapsed_ms: number;
};

type ActTargetItem = { ref?: string; selector?: string; x?: number; y?: number };

function readItemString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isActItem(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** What each item of an act names, in the order they run: a batch's and a fill's one by one. */
function actTargetItems(request: Record<string, unknown>): ActTargetItem[] {
  if (Array.isArray(request.actions)) {
    return request.actions.filter(isActItem).flatMap(actTargetItems);
  }
  if (Array.isArray(request.fields)) {
    return request.fields.filter(isActItem).map((field) => ({ ref: readItemString(field.ref) }));
  }
  switch (request.kind) {
    case "clickCoords":
      return [
        typeof request.x === "number" && typeof request.y === "number"
          ? { x: request.x, y: request.y }
          : {},
      ];
    case "drag":
      return [
        {
          ref: readItemString(request.startRef),
          selector: readItemString(request.startSelector),
        },
      ];
    case "click":
    case "type":
    case "hover":
    case "scrollIntoView":
    case "select":
      return [{ ref: readItemString(request.ref), selector: readItemString(request.selector) }];
    default:
      return [{}];
  }
}

/**
 * Locate an act's targets before it runs: `target` for a plain act, `targets` for a batch
 * or a fill, one per item in the order they run, each located on the page as it stood
 * before the first ran. Empty when the lookup fails; never throws past an abort.
 */
export async function locateActTargets(params: {
  request: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  signal?: AbortSignal;
}): Promise<Pick<BrowserRecorderAct, "target" | "targets">> {
  const items = actTargetItems(params.request);
  const listed = Array.isArray(params.request.actions) || Array.isArray(params.request.fields);
  try {
    const { targets } = await browserRecorderLocate(params.baseUrl, {
      targetId: readItemString(params.request.targetId),
      items,
      profile: params.profile,
      signal: params.signal,
    });
    if (!Array.isArray(targets) || targets.length !== items.length) {
      return {};
    }
    return listed ? { targets } : { target: targets[0] };
  } catch (err) {
    params.signal?.throwIfAborted();
    logger.warn(`browser recorder: act target lookup failed: ${formatErrorMessage(err)}`);
    return {};
  }
}

/**
 * Describe a failed act for the record: its error, the element on top at its target's
 * centre when that is not the target, and the time it took. Never throws past an abort.
 */
export async function describeActFailure(params: {
  error: unknown;
  request: Record<string, unknown>;
  located: Pick<BrowserRecorderAct, "target" | "targets">;
  elapsedMs: number;
  baseUrl?: string;
  profile?: string;
  signal?: AbortSignal;
}): Promise<BrowserRecorderAct> {
  const ref = typeof params.request.ref === "string" ? params.request.ref : undefined;
  const selector =
    typeof params.request.selector === "string" ? params.request.selector : undefined;
  let covered: BrowserRecorderAct["covered"];
  if (ref || selector) {
    try {
      covered = (
        await browserRecorderHitTest(params.baseUrl, {
          targetId:
            typeof params.request.targetId === "string" ? params.request.targetId : undefined,
          ref,
          selector,
          profile: params.profile,
          signal: params.signal,
        })
      ).covered;
    } catch (err) {
      params.signal?.throwIfAborted();
      logger.warn(`browser recorder: act hit-test failed: ${formatErrorMessage(err)}`);
    }
  }
  return {
    error: formatErrorMessage(params.error),
    ...(covered ? { covered } : {}),
    ...params.located,
    elapsed_ms: Math.round(params.elapsedMs),
  };
}

/** Attach an act's record to the failure it ends in, for core to put in the result's details. */
export function withActRecord<E>(error: E, act: BrowserRecorderAct): E {
  if (error instanceof Error && Object.isExtensible(error)) {
    Object.defineProperty(error, TOOL_ERROR_DETAILS, {
      configurable: true,
      enumerable: false,
      value: { recorder: { act } },
      writable: true,
    });
  }
  return error;
}
