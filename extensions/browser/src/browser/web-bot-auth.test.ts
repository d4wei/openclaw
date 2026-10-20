import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authorityOf,
  createWebBotAuthSigner,
  installWebBotAuth,
  loadWebBotAuthSigner,
  signatureBase,
  webBotAuthRouteHandler,
} from "./web-bot-auth.js";

// The Ed25519 key whose seed is the bytes 0..31, as PKCS#8 DER in base64, and the headers the
// operator's Python signer (agentcosign src/audit/signing.py) gives for it at created 1700000000
// with a nonce of 64 bytes of 7, for the authority shop.example. Ed25519 is deterministic, so both
// sides must agree byte for byte.
const KEY = "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";
const CONFIG = { signatureAgent: "https://deciq.ai", keyId: "test-kid" };
const NONCE = Buffer.alloc(64, 7);
const GOLDEN = {
  "signature-agent": '"https://deciq.ai"',
  "signature-input":
    'sig1=("@authority" "signature-agent");created=1700000000;expires=1700000060;' +
    'keyid="test-kid";alg="ed25519";' +
    `nonce="${NONCE.toString("base64")}";tag="web-bot-auth"`,
  signature:
    "sig1=:OKhdCQQOwUFbIUn9XUHvQLrITMam0vvggnH9FZ/3SbA55Uu+bRXFBRuNbre6pcOe" +
    "ugqAxfLJqtEb/+WKLkHmCw==:",
};

function goldenSigner() {
  const key = createPrivateKey({ key: Buffer.from(KEY, "base64"), format: "der", type: "pkcs8" });
  return {
    key,
    signer: createWebBotAuthSigner(CONFIG, key, { now: () => 1700000000.9, nonce: () => NONCE }),
  };
}

describe("web bot auth signer", () => {
  it("gives the operator's Python signer's headers byte for byte", () => {
    expect(goldenSigner().signer.headers("shop.example")).toEqual(GOLDEN);
  });

  it("signs a base the public key verifies, with a fresh nonce per request", () => {
    const key = createPrivateKey({ key: Buffer.from(KEY, "base64"), format: "der", type: "pkcs8" });
    const signer = createWebBotAuthSigner(CONFIG, key);
    const first = signer.headers("shop.example");
    const second = signer.headers("shop.example");
    expect(first["signature-input"]).not.toBe(second["signature-input"]);
    const params = first["signature-input"].slice("sig1=".length);
    const signature = Buffer.from(first.signature.slice("sig1=:".length, -1), "base64");
    const base = signatureBase("shop.example", first["signature-agent"], params);
    expect(verify(null, Buffer.from(base), createPublicKey(key), signature)).toBe(true);
  });

  it("reads the authority as RFC 9421 covers it", () => {
    expect(authorityOf("https://Shop.Example/products/a?x=1")).toBe("shop.example");
    expect(authorityOf("https://shop.example:443/")).toBe("shop.example");
    expect(authorityOf("http://shop.example:8080/")).toBe("shop.example:8080");
    expect(authorityOf("data:text/plain,hi")).toBeNull();
    expect(authorityOf("not a url")).toBeNull();
  });
});

describe("loading the key", () => {
  it("signs nothing without the config block, and says why without the key", () => {
    expect(loadWebBotAuthSigner(undefined, { WEB_BOT_AUTH_KEY: KEY })).toEqual({ signer: null });
    expect(loadWebBotAuthSigner(CONFIG, {}).reason).toBe("WEB_BOT_AUTH_KEY is not set");
    expect(loadWebBotAuthSigner(CONFIG, { WEB_BOT_AUTH_KEY: "bm90IGEga2V5" }).reason).toBe(
      "WEB_BOT_AUTH_KEY is not a base64 PKCS#8 private key",
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    expect(loadWebBotAuthSigner(CONFIG, { WEB_BOT_AUTH_KEY: rsa.toString("base64") }).reason).toBe(
      "WEB_BOT_AUTH_KEY is not an Ed25519 key",
    );
    expect(loadWebBotAuthSigner(CONFIG, { WEB_BOT_AUTH_KEY: KEY }).signer?.keyId).toBe("test-kid");
  });
});

describe("the route", () => {
  function routed(url: string, headers: Record<string, string> = {}) {
    const route = { fallback: vi.fn(async () => {}) };
    const request = { url: () => url, headers: () => headers };
    return { route, request };
  }

  it("sends an http(s) request on signed for its own authority, keeping its headers", async () => {
    const { route, request } = routed("https://shop.example/cart", { accept: "text/html" });
    await webBotAuthRouteHandler(goldenSigner().signer)(route as never, request as never);
    expect(route.fallback).toHaveBeenCalledWith({ headers: { accept: "text/html", ...GOLDEN } });
  });

  it("lets any other request through untouched", async () => {
    const { route, request } = routed("data:image/png;base64,AAAA");
    await webBotAuthRouteHandler(goldenSigner().signer)(route as never, request as never);
    expect(route.fallback).toHaveBeenCalledWith();
  });

  it("installs once per context, and warns once when the key is missing", async () => {
    const context = { route: vi.fn(async () => {}) };
    const env = { WEB_BOT_AUTH_KEY: KEY };
    expect(await installWebBotAuth(context as never, CONFIG, env)).toBe(true);
    expect(await installWebBotAuth(context as never, CONFIG, env)).toBe(true);
    expect(context.route).toHaveBeenCalledTimes(1);
    expect(await installWebBotAuth({ route: vi.fn() } as never, undefined, env)).toBe(false);

    const warn = vi.fn();
    expect(await installWebBotAuth({ route: vi.fn() } as never, CONFIG, {}, warn)).toBe(false);
    expect(await installWebBotAuth({ route: vi.fn() } as never, CONFIG, {}, warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("WEB_BOT_AUTH_KEY is not set");
  });
});
