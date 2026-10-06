/** Page geometry and a full-page capture for the browser page-read recorder. */
import { getPageForTargetId, refLocator, restoreRoleRefsForTarget } from "./pw-session.js";

export type RecorderBox = { x: number; y: number; w: number; h: number };

export type RecorderCapture = {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  page: { w: number; h: number };
  boxes: Record<string, RecorderBox | null>;
  buffer: Buffer;
};

// A ref that resolves to nothing must not hold the capture for Playwright's default wait.
const BOX_TIMEOUT_MS = 500;
const BOX_BATCH = 32;
const SCREENSHOT_TIMEOUT_MS = 30_000;

/**
 * Measure every ref through the same resolver actions use, then capture the
 * whole document at CSS scale so boxes (document pixels) land on the image.
 */
export async function captureRecorderViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  refs: readonly string[];
  signal?: AbortSignal;
}): Promise<RecorderCapture> {
  const page = await getPageForTargetId(opts);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const view = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      x: window.visualViewport?.pageLeft ?? window.scrollX,
      y: window.visualViewport?.pageTop ?? window.scrollY,
      w: window.innerWidth,
      h: window.innerHeight,
      pageW: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth),
      pageH: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight),
      title: document.title,
      url: location.href,
    };
  });
  const boxes: Record<string, RecorderBox | null> = {};
  for (let start = 0; start < opts.refs.length; start += BOX_BATCH) {
    opts.signal?.throwIfAborted();
    const batch = opts.refs.slice(start, start + BOX_BATCH);
    const measured = await Promise.all(
      batch.map(async (ref) => {
        try {
          return await refLocator(page, ref).boundingBox({ timeout: BOX_TIMEOUT_MS });
        } catch {
          return null;
        }
      }),
    );
    batch.forEach((ref, index) => {
      const box = measured[index];
      boxes[ref] = box
        ? { x: box.x + view.x, y: box.y + view.y, w: box.width, h: box.height }
        : null;
    });
  }
  opts.signal?.throwIfAborted();
  const buffer = await page.screenshot({
    type: "png",
    fullPage: true,
    scale: "css",
    timeout: SCREENSHOT_TIMEOUT_MS,
  });
  return {
    url: view.url,
    title: view.title,
    viewport: { w: view.w, h: view.h },
    page: { w: view.pageW, h: view.pageH },
    boxes,
    buffer,
  };
}
