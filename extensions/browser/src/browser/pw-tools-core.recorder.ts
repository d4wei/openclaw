/** Page geometry and a full-page capture for the browser page-read recorder. */
import type { Page } from "playwright-core";
import { getPageForTargetId, refLocator, restoreRoleRefsForTarget } from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE, withPageScopedCdpClient } from "./pw-session.page-cdp.js";

export type RecorderBox = { x: number; y: number; w: number; h: number };

/** The page the last capture pictured; while a page is still it, no new image is taken. */
export type RecorderPageIdentity = { url: string; page: { w: number; h: number } };

export type RecorderCapture = {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  page: { w: number; h: number };
  boxes: Record<string, RecorderBox | null>;
  /**
   * The full-page PNG; null when the page is the one `unchanged` named (`shares` true), or when
   * the document is not a web page (a JSON or XML file Chrome shows raw), which gets no image.
   */
  buffer: Buffer | null;
  shares: boolean;
};

/** Documents a capture pictures; anything else Chrome shows raw, tall and slow to picture. */
const PAGE_CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml)$/i;

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
  /**
   * DOM identities (backend node ids) of refs the action cache does not hold, such as
   * those only in a full outline read beside the model's; measured over CDP instead.
   */
  nodes?: Readonly<Record<string, number>>;
  /**
   * The page the previous capture pictured. A page at the same URL and document size is
   * taken as unchanged and gets no image: the full-page capture is the costly step of a
   * read, and a visit reads one page several times (navigate, then text, then snapshot).
   */
  unchanged?: RecorderPageIdentity;
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
      contentType: document.contentType,
    };
  });
  const boxes: Record<string, RecorderBox | null> = {};
  const uncached: string[] = [];
  for (let start = 0; start < opts.refs.length; start += BOX_BATCH) {
    opts.signal?.throwIfAborted();
    const batch = opts.refs.slice(start, start + BOX_BATCH);
    const measured = await Promise.all(
      batch.map(async (ref) => {
        let locator: ReturnType<typeof refLocator>;
        try {
          locator = refLocator(page, ref);
        } catch {
          uncached.push(ref);
          return null;
        }
        try {
          return await locator.boundingBox({ timeout: BOX_TIMEOUT_MS });
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
  const byNode = uncached.filter((ref) => opts.nodes?.[ref] !== undefined);
  if (byNode.length) {
    const measured = await measureNodesViaCdp(page, byNode, opts.nodes ?? {}, opts.signal);
    for (const [ref, box] of measured) {
      boxes[ref] = box ? { ...box, x: box.x + view.x, y: box.y + view.y } : null;
    }
  }
  opts.signal?.throwIfAborted();
  const same =
    opts.unchanged !== undefined &&
    opts.unchanged.url === view.url &&
    opts.unchanged.page.w === view.pageW &&
    opts.unchanged.page.h === view.pageH;
  const buffer =
    same || !PAGE_CONTENT_TYPES.test(view.contentType)
      ? null
      : await page.screenshot({
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
    shares: same,
  };
}

/** Viewport-relative border boxes of DOM nodes by backend id; an unrendered node gets null. */
async function measureNodesViaCdp(
  page: Page,
  refs: readonly string[],
  nodes: Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<Map<string, RecorderBox | null>> {
  return await withPageScopedCdpClient({
    page,
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    fn: async (send) => {
      const measured = new Map<string, RecorderBox | null>();
      for (const ref of refs) {
        signal?.throwIfAborted();
        try {
          const { model } = await send("DOM.getBoxModel", { backendNodeId: nodes[ref] });
          // The border quad is four corners as x,y pairs.
          const xs = model.border.filter((_, index) => index % 2 === 0);
          const ys = model.border.filter((_, index) => index % 2 === 1);
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          measured.set(ref, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
        } catch {
          measured.set(ref, null);
        }
      }
      return measured;
    },
  });
}

/** The element on top at an act target's centre, when it is not the target itself. */
export type RecorderCovered = {
  role: string;
  name: string;
  ref?: string;
  box: RecorderBox;
};

/**
 * Hit-test the centre of an act's target, read-only: which element the page would hand
 * the pointer there. A target with no box (detached, not found, not rendered) has no
 * centre, so nothing is reported as covering it.
 */
export async function hitTestRecorderViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  signal?: AbortSignal;
}): Promise<{ covered?: RecorderCovered }> {
  const page = await getPageForTargetId(opts);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  let locator: ReturnType<typeof refLocator>;
  try {
    locator = opts.ref
      ? refLocator(page, opts.ref)
      : page.locator(opts.selector ?? ":not(*)").first();
  } catch {
    return {};
  }
  const box = await locator.boundingBox({ timeout: BOX_TIMEOUT_MS }).catch(() => null);
  const target = box
    ? await locator.elementHandle({ timeout: BOX_TIMEOUT_MS }).catch(() => null)
    : null;
  if (!box || !target) {
    return {};
  }
  opts.signal?.throwIfAborted();
  try {
    const covered = await page.evaluate(
      ({ x, y, targetElement, marker }) => {
        const hit = document.elementFromPoint(x, y);
        if (
          !hit ||
          hit === targetElement ||
          (targetElement instanceof Node && targetElement.contains(hit))
        ) {
          return null;
        }
        const element = hit.closest(`[${marker}]`) ?? hit;
        const tag = element.tagName.toLowerCase();
        const implicit: Record<string, string> = {
          a: element.hasAttribute("href") ? "link" : "generic",
          button: "button",
          dialog: "dialog",
          footer: "contentinfo",
          header: "banner",
          iframe: "iframe",
          img: "img",
          input: "textbox",
          nav: "navigation",
          select: "combobox",
          textarea: "textbox",
        };
        const role =
          element.getAttribute("role") ??
          (/^h[1-6]$/.test(tag) ? "heading" : (implicit[tag] ?? "generic"));
        const name = (
          element.getAttribute("aria-label") ??
          element.getAttribute("alt") ??
          element.getAttribute("title") ??
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- The name is the rendered text, as the outline gives it.
          (element as HTMLElement).innerText ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        const rect = element.getBoundingClientRect();
        const ref = element.getAttribute(marker);
        return {
          role,
          name,
          ...(ref ? { ref } : {}),
          box: {
            x: rect.x + window.scrollX,
            y: rect.y + window.scrollY,
            w: rect.width,
            h: rect.height,
          },
        };
      },
      {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        targetElement: target,
        marker: BROWSER_REF_MARKER_ATTRIBUTE,
      },
    );
    return covered ? { covered } : {};
  } finally {
    void target.dispose().catch(() => {});
  }
}

/** What one act item names on the page: an element by ref or selector, or a viewport point. */
export type RecorderTargetItem = { ref?: string; selector?: string; x?: number; y?: number };

/** Where an act item's target is on the page, in page pixels, with the view it was found in. */
export type RecorderTarget = {
  ref: string | null;
  box: RecorderBox | null;
  /** A coordinate click's point. */
  point?: { x: number; y: number };
  scroll: { x: number; y: number };
  viewport: { w: number; h: number };
};

/**
 * Locate act targets before the act runs, read-only: an element named by ref or selector
 * through the resolver actions use, a viewport point as its page point and the element the
 * page hands the pointer there (or its nearest ancestor with a snapshot ref). An item that
 * names neither, or a target that does not resolve, gets a null box.
 */
export async function locateRecorderTargetsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  items: readonly RecorderTargetItem[];
  signal?: AbortSignal;
}): Promise<{ targets: RecorderTarget[] }> {
  const page = await getPageForTargetId(opts);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const view = await page.evaluate(() => ({
    x: window.visualViewport?.pageLeft ?? window.scrollX,
    y: window.visualViewport?.pageTop ?? window.scrollY,
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const scroll = { x: view.x, y: view.y };
  const viewport = { w: view.w, h: view.h };
  const targets = await Promise.all(
    opts.items.map(async (item): Promise<RecorderTarget> => {
      if (typeof item.x === "number" && typeof item.y === "number") {
        const hit = await page
          .evaluate(
            ({ x, y, marker }) => {
              const found = document.elementFromPoint(x, y);
              const element = found?.closest(`[${marker}]`) ?? found;
              if (!element) {
                return null;
              }
              const rect = element.getBoundingClientRect();
              return {
                ref: element.getAttribute(marker),
                box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              };
            },
            { x: item.x, y: item.y, marker: BROWSER_REF_MARKER_ATTRIBUTE },
          )
          .catch(() => null);
        return {
          ref: hit?.ref ?? null,
          box: hit ? { ...hit.box, x: hit.box.x + view.x, y: hit.box.y + view.y } : null,
          point: { x: item.x + view.x, y: item.y + view.y },
          scroll,
          viewport,
        };
      }
      const ref = item.ref ?? null;
      if (!item.ref && !item.selector) {
        return { ref, box: null, scroll, viewport };
      }
      let locator: ReturnType<typeof refLocator>;
      try {
        locator = item.ref ? refLocator(page, item.ref) : page.locator(item.selector!).first();
      } catch {
        return { ref, box: null, scroll, viewport };
      }
      const box = await locator.boundingBox({ timeout: BOX_TIMEOUT_MS }).catch(() => null);
      return {
        ref,
        box: box ? { x: box.x + view.x, y: box.y + view.y, w: box.width, h: box.height } : null,
        scroll,
        viewport,
      };
    }),
  );
  opts.signal?.throwIfAborted();
  return { targets };
}
