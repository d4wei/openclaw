// A local profile opens its tabs through Playwright when Web Bot Auth is configured, so the first
// document is signed; without the block it keeps upstream's raw CDP path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import * as cdpModule from "./cdp.js";
import * as pwAiModule from "./pw-ai-module.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

const runtimeConfig = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfig: () => runtimeConfig.value,
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
  runtimeConfig.value = {};
  vi.restoreAllMocks();
});

function openLocalTab() {
  const createdViaCdp = vi
    .spyOn(cdpModule, "createTargetViaCdp")
    .mockResolvedValue({ targetId: "VIA_CDP", finalUrl: "https://1.1.1.1/" });
  const createPageViaPlaywright = vi.fn(async () => ({
    targetId: "VIA_PW",
    title: "Shop",
    url: "https://1.1.1.1/",
    type: "page" as const,
    close: async () => {},
  }));
  vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
    createPageViaPlaywright,
  } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);
  global.fetch = withBrowserFetchPreconnect(
    vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => [
            {
              id: "VIA_CDP",
              title: "Shop",
              url: "https://1.1.1.1/",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/VIA_CDP",
              type: "page",
            },
          ],
        }) as unknown as Response,
    ),
  );
  const state = makeState("openclaw");
  state.resolved.ssrfPolicy = {};
  state.resolved.profiles.openclaw = {
    cdpUrl: "ws://127.0.0.1:18800/devtools/browser/SESSION?token=abc",
    color: "#FF4500",
  };
  const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  return {
    open: () => openclaw.openTab("https://1.1.1.1/"),
    createdViaCdp,
    createPageViaPlaywright,
  };
}

describe("opening a tab with Web Bot Auth configured", () => {
  it("goes through Playwright, so the route is attached before the first document", async () => {
    runtimeConfig.value = {
      browser: { webBotAuth: { signatureAgent: "https://deciq.ai", keyId: "k" } },
    };
    const { open, createdViaCdp, createPageViaPlaywright } = openLocalTab();
    expect((await open()).targetId).toBe("VIA_PW");
    expect(createPageViaPlaywright).toHaveBeenCalledTimes(1);
    expect(createdViaCdp).not.toHaveBeenCalled();
  });

  it("keeps upstream's raw CDP path without the block", async () => {
    const { open, createdViaCdp, createPageViaPlaywright } = openLocalTab();
    expect((await open()).targetId).toBe("VIA_CDP");
    expect(createdViaCdp).toHaveBeenCalledTimes(1);
    expect(createPageViaPlaywright).not.toHaveBeenCalled();
  });
});
