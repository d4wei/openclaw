/**
 * Record-only details a tool failure carries into its error result. The model-facing
 * error text is unchanged; the details land beside it in the result's `details`.
 */

// A registered symbol, so a plugin can attach details without importing core.
const TOOL_ERROR_DETAILS = Symbol.for("openclaw.toolErrorDetails");

/** Attach details to a tool failure. Best effort: a non-extensible error is returned unchanged. */
export function withToolErrorDetails<E>(error: E, details: Record<string, unknown>): E {
  try {
    if (!(error instanceof Error) || !Object.isExtensible(error)) {
      return error;
    }
    Object.defineProperty(error, TOOL_ERROR_DETAILS, {
      configurable: true,
      enumerable: false,
      value: details,
      writable: true,
    });
  } catch {
    // Details are advisory. Never let attaching them replace the failure being reported.
  }
  return error;
}

/** Read the details a tool failure carries, when it carries a plain record. */
export function readToolErrorDetails(error: unknown): Record<string, unknown> | undefined {
  try {
    if (!(error instanceof Error)) {
      return undefined;
    }
    const details: unknown = Object.getOwnPropertyDescriptor(error, TOOL_ERROR_DETAILS)?.value;
    return details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
