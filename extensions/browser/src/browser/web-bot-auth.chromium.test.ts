import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { gotoPageWithNavigationGuard } from "./pw-session-navigation.js";
import { closePlaywrightBrowserConnection, createPageViaPlaywright } from "./pw-session.js";
import { getFreePort } from "./test-port.js";
import { installWebBotAuth, signatureBase } from "./web-bot-auth.js";

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfig: () => ({
    browser: { webBotAuth: { signatureAgent: "https://deciq.ai", keyId: "test-kid" } },
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const KEY = "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";
const PUBLIC = createPublicKey(
  createPrivateKey({ key: Buffer.from(KEY, "base64"), format: "der", type: "pkcs8" }),
);
const CONFIG = { signatureAgent: "https://deciq.ai", keyId: "test-kid" };

type Seen = { method: string; path: string; authority: string; headers: IncomingHttpHeaders };
type Answer = { status?: number; headers?: Record<string, string>; body?: string };

function listen(handler: (seen: Seen) => Answer) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const entry = {
      method: request.method ?? "",
      path: request.url ?? "",
      authority: request.headers.host ?? "",
      headers: request.headers,
    };
    seen.push(entry);
    const answer = handler(entry);
    response.writeHead(answer.status ?? 200, answer.headers ?? {});
    response.end(answer.body ?? "");
  });
  return { server, seen };
}

async function start(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

function verified(entry: Seen): boolean {
  const input = String(entry.headers["signature-input"] ?? "");
  const signature = String(entry.headers.signature ?? "");
  if (!input.startsWith("sig1=") || !signature.startsWith("sig1=:")) {
    return false;
  }
  const base = signatureBase(
    entry.authority,
    String(entry.headers["signature-agent"]),
    input.slice(5),
  );
  return verify(null, Buffer.from(base), PUBLIC, Buffer.from(signature.slice(6, -1), "base64"));
}

describe.runIf(process.env.OPENCLAW_BROWSER_WEB_BOT_AUTH_E2E === "1")(
  "Web Bot Auth in Chromium",
  () => {
    it("signs each request for its own authority through the guarded navigation", async () => {
      const other = listen((entry): Answer => ({
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "content-type": "application/json",
        },
        body: entry.method === "OPTIONS" ? "" : "{}",
      }));
      const otherPort = await start(other.server, "127.0.0.1");
      const store = listen((entry): Answer => {
        if (entry.path === "/") {
          return { status: 302, headers: { location: "/page" } };
        }
        if (entry.path === "/page") {
          return {
            headers: { "content-type": "text/html" },
            body:
              `<img src="/pixel.gif"><script>fetch("/api").then(() => ` +
              `fetch("http://localhost:${otherPort}/api", ` +
              `{ headers: { "content-type": "application/json" } }))` +
              `.then(() => { document.title = "done"; });</script>`,
          };
        }
        return { headers: { "content-type": "application/json" }, body: "{}" };
      });
      const storePort = await start(store.server, "127.0.0.1");
      const cdpPort = await getFreePort();
      const rootDir = tempDirs.make("openclaw-web-bot-auth-");
      const chrome = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${cdpPort}`],
        },
      );
      const browser = await getPlaywrightCore().chromium.connectOverCDP(
        `http://127.0.0.1:${cdpPort}`,
      );
      try {
        const context = expectDefined(browser.contexts()[0]);
        expect(await installWebBotAuth(context, CONFIG, { WEB_BOT_AUTH_KEY: KEY })).toBe(true);
        const page = context.pages()[0] ?? (await context.newPage());
        // The browser tool's own guarded navigation, whose page route answers first and falls back.
        await gotoPageWithNavigationGuard({
          cdpUrl: `http://127.0.0.1:${cdpPort}`,
          page,
          url: `http://127.0.0.1:${storePort}/`,
          timeoutMs: 10_000,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        });
        await expect.poll(() => page.title(), { timeout: 10_000 }).toBe("done");

        expect(store.seen.map((entry) => entry.path)).toEqual(
          expect.arrayContaining(["/", "/page", "/pixel.gif", "/api"]),
        );
        for (const entry of [...store.seen, ...other.seen.filter((e) => e.method !== "OPTIONS")]) {
          if (entry.path === "/favicon.ico") {
            continue;
          }
          expect(entry.headers["signature-agent"], entry.path).toBe('"https://deciq.ai"');
          expect(verified(entry), `${entry.authority}${entry.path}`).toBe(true);
        }
        expect(other.seen.some((entry) => entry.method === "GET" && entry.path === "/api")).toBe(
          true,
        );
      } finally {
        await browser.close();
        await chrome.close();
        for (const { server } of [store, other]) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    }, 30_000);

    it("signs a new tab's first document on the browser tool's own connection", async () => {
      const store = listen((): Answer => ({
        headers: { "content-type": "text/html" },
        body: "<p>hi</p>",
      }));
      const storePort = await start(store.server, "127.0.0.1");
      const cdpPort = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      const rootDir = tempDirs.make("openclaw-web-bot-auth-open-");
      const chrome = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${cdpPort}`],
        },
      );
      process.env.WEB_BOT_AUTH_KEY = KEY;
      try {
        await createPageViaPlaywright({
          cdpUrl,
          url: `http://127.0.0.1:${storePort}/first`,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        });
        const first = store.seen.find((entry) => entry.path === "/first");
        expect(first && verified(first)).toBe(true);
      } finally {
        delete process.env.WEB_BOT_AUTH_KEY;
        await closePlaywrightBrowserConnection({ cdpUrl });
        await chrome.close();
        store.server.closeAllConnections();
        await new Promise<void>((resolve) => store.server.close(() => resolve()));
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

function expectDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
