/**
 * Browser page-read recorder.
 *
 * Off by default. When `browser.recorder.enabled` is set, each page read the
 * model receives is also written whole under `<stateDir>/recorder/` beside its
 * cut copy; the model-facing result is unchanged apart from `details.recorder`.
 */
import { getRuntimeConfig } from "./browser-tool.runtime.js";

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
