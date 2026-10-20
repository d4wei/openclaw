/**
 * Web Bot Auth for the browser tool's own Chrome: every http(s) request the managed browser makes
 * carries the three headers of RFC 9421 and draft-meunier-web-bot-auth-architecture-02, signed with
 * an Ed25519 key, so a site can tell which agent operator sent it.
 *
 * `browser.webBotAuth` names the operator's key directory (`signatureAgent`) and the key's id in it
 * (`keyId`); the private key is read from the `WEB_BOT_AUTH_KEY` environment variable (PKCS#8 DER,
 * one base64 line) and nowhere else. Each request is signed for its own authority with a fresh
 * `created`, `expires` and nonce. With no config block the browser behaves as upstream; with the
 * block but no usable key, requests go unsigned and the reason is logged once, naming the problem
 * and never the value.
 */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { BrowserContext, Request, Route } from "playwright-core";

const log = createSubsystemLogger("browser").child("web-bot-auth");

export const WEB_BOT_AUTH_KEY_ENV = "WEB_BOT_AUTH_KEY";
const LABEL = "sig1";
const COMPONENTS = ["@authority", "signature-agent"] as const;
const TAG = "web-bot-auth";
const VALIDITY_S = 60;
const NONCE_BYTES = 64;

export type WebBotAuthConfig = { signatureAgent: string; keyId: string };

export type WebBotAuthHeaders = {
  "signature-agent": string;
  "signature-input": string;
  signature: string;
};

export type WebBotAuthSigner = {
  keyId: string;
  headers: (authority: string) => WebBotAuthHeaders;
};

function sfString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The target URI's authority as RFC 9421 section 2.2.3 covers it: the lower-cased host, with the
 * port only when it is not the scheme's default; null for a URL that is not http(s).
 */
export function authorityOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** RFC 9421 section 2.5: one line per covered component, in order, then `@signature-params`. */
export function signatureBase(authority: string, signatureAgent: string, params: string): string {
  return [
    `"@authority": ${authority}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join("\n");
}

export function createWebBotAuthSigner(
  config: WebBotAuthConfig,
  key: KeyObject,
  opts: { now?: () => number; nonce?: () => Buffer } = {},
): WebBotAuthSigner {
  const now = opts.now ?? (() => Date.now() / 1000);
  const nonce = opts.nonce ?? (() => randomBytes(NONCE_BYTES));
  const agent = sfString(config.signatureAgent);
  const components = COMPONENTS.map(sfString).join(" ");
  return {
    keyId: config.keyId,
    headers(authority) {
      const created = Math.floor(now());
      const params =
        `(${components});created=${created};expires=${created + VALIDITY_S}` +
        `;keyid=${sfString(config.keyId)}` +
        `;alg="ed25519";nonce=${sfString(nonce().toString("base64"))};tag=${sfString(TAG)}`;
      const signature = sign(
        null,
        Buffer.from(signatureBase(authority, agent, params)),
        key,
      ).toString("base64");
      return {
        "signature-agent": agent,
        "signature-input": `${LABEL}=${params}`,
        signature: `${LABEL}=:${signature}:`,
      };
    },
  };
}

/**
 * The signer `config` and the environment's key make, or null with the reason it could not be made.
 */
export function loadWebBotAuthSigner(
  config: WebBotAuthConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { signer: WebBotAuthSigner | null; reason?: string } {
  if (!config) {
    return { signer: null };
  }
  const encoded = env[WEB_BOT_AUTH_KEY_ENV]?.trim();
  if (!encoded) {
    return { signer: null, reason: `${WEB_BOT_AUTH_KEY_ENV} is not set` };
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    // The library's message may quote the input, so only the variable's name is reported.
    return { signer: null, reason: `${WEB_BOT_AUTH_KEY_ENV} is not a base64 PKCS#8 private key` };
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return { signer: null, reason: `${WEB_BOT_AUTH_KEY_ENV} is not an Ed25519 key` };
  }
  return { signer: createWebBotAuthSigner(config, key) };
}

/**
 * The route handler: an http(s) request goes on signed for its own authority, anything else as it
 * was. It falls back, so a page's own routes (the navigation guard) decide first and other context
 * routes still run.
 */
export function webBotAuthRouteHandler(signer: WebBotAuthSigner) {
  return async (route: Route, request: Request) => {
    const authority = authorityOf(request.url());
    if (!authority) {
      await route.fallback();
      return;
    }
    await route.fallback({ headers: { ...request.headers(), ...signer.headers(authority) } });
  };
}

const installs = new WeakMap<BrowserContext, Promise<boolean>>();
let notedUnsigned = false;

/**
 * Signs every request `context` makes when `config` and the key make a signer: one route per
 * context, and every caller for a context gets the same promise, so a navigation can wait for the
 * route before its first request. Never rejects, since an unsigned request is still a request.
 */
export function installWebBotAuth(
  context: BrowserContext,
  config: WebBotAuthConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => log.warn(message),
): Promise<boolean> {
  const existing = installs.get(context);
  if (existing) {
    return existing;
  }
  const installing = install(context, config, env, warn);
  installs.set(context, installing);
  return installing;
}

async function install(
  context: BrowserContext,
  config: WebBotAuthConfig | undefined,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Promise<boolean> {
  const { signer, reason } = loadWebBotAuthSigner(config, env);
  if (!signer) {
    if (reason && !notedUnsigned) {
      notedUnsigned = true;
      warn(`browser requests go unsigned (no Web Bot Auth): ${reason}`);
    }
    return false;
  }
  try {
    await context.route("**", webBotAuthRouteHandler(signer));
  } catch (err) {
    warn(`browser requests go unsigned (no Web Bot Auth): the route was refused: ${String(err)}`);
    return false;
  }
  return true;
}
