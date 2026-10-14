import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const { locateRecorderTargetsViaPlaywright } = await import("./pw-tools-core.recorder.js");
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "t1" };

/** A fake element: its viewport rect and, when it carries one, its snapshot ref. */
function element(rect: { x: number; y: number; width: number; height: number }, ref?: string) {
  const self = {
    getBoundingClientRect: () => rect,
    getAttribute: (name: string) => (name === BROWSER_REF_MARKER_ATTRIBUTE ? (ref ?? null) : null),
    closest: (_selector: string): unknown => (ref ? self : null),
  };
  return self;
}

/** A page scrolled by (0, 1200) whose in-page functions run against fake globals. */
function installPage(opts: { hit?: unknown; selectorBox?: unknown } = {}) {
  vi.stubGlobal("window", {
    visualViewport: { pageLeft: 0, pageTop: 1200 },
    scrollX: 0,
    scrollY: 1200,
    innerWidth: 1280,
    innerHeight: 720,
  });
  vi.stubGlobal("document", { elementFromPoint: vi.fn(() => opts.hit ?? null) });
  const selectorLocator = {
    boundingBox: vi.fn(async () => opts.selectorBox ?? null),
  };
  const page = {
    evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)),
    locator: vi.fn(() => ({ first: () => selectorLocator })),
  };
  setPwToolsCoreCurrentPage(page);
  return { page, selectorLocator };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recorder act targets", () => {
  const view = { scroll: { x: 0, y: 1200 }, viewport: { w: 1280, h: 720 } };

  it("puts a ref's box in page pixels, with the scroll and viewport it was found in", async () => {
    installPage();
    setPwToolsCoreCurrentRefLocator({
      boundingBox: vi.fn(async () => ({ x: 40, y: 300, width: 120, height: 32 })),
    });

    const { targets } = await locateRecorderTargetsViaPlaywright({
      ...target,
      items: [{ ref: "e5" }],
    });

    expect(targets).toEqual([{ ref: "e5", box: { x: 40, y: 1500, w: 120, h: 32 }, ...view }]);
    expect(getPwToolsCoreSessionMocks().restoreRoleRefsForTarget).toHaveBeenCalled();
  });

  it("locates a selector's first match", async () => {
    const { page } = installPage({ selectorBox: { x: 10, y: 20, width: 30, height: 40 } });

    const { targets } = await locateRecorderTargetsViaPlaywright({
      ...target,
      items: [{ selector: ".add-to-cart" }],
    });

    expect(page.locator).toHaveBeenCalledWith(".add-to-cart");
    expect(targets).toEqual([{ ref: null, box: { x: 10, y: 1220, w: 30, h: 40 }, ...view }]);
  });

  it("converts a point to page pixels and boxes the marked element under it", async () => {
    installPage({ hit: element({ x: 880, y: 470, width: 40, height: 40 }, "e40") });

    const { targets } = await locateRecorderTargetsViaPlaywright({
      ...target,
      items: [{ x: 898, y: 487 }],
    });

    expect(targets).toEqual([
      {
        ref: "e40",
        box: { x: 880, y: 1670, w: 40, h: 40 },
        point: { x: 898, y: 1687 },
        ...view,
      },
    ]);
  });

  it("keeps the point when nothing is under it", async () => {
    installPage();

    const { targets } = await locateRecorderTargetsViaPlaywright({
      ...target,
      items: [{ x: 5, y: 6 }],
    });

    expect(targets).toEqual([{ ref: null, box: null, point: { x: 5, y: 1206 }, ...view }]);
  });

  it("gives a null box to an unknown ref, an unrendered target and an item naming none", async () => {
    installPage();
    getPwToolsCoreSessionMocks().refLocator.mockImplementationOnce(() => {
      throw new Error('Unknown ref "e99".');
    });

    const { targets } = await locateRecorderTargetsViaPlaywright({
      ...target,
      items: [{ ref: "e99" }, { selector: "#gone" }, {}],
    });

    expect(targets).toEqual([
      { ref: "e99", box: null, ...view },
      { ref: null, box: null, ...view },
      { ref: null, box: null, ...view },
    ]);
  });
});
