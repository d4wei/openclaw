import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
} from "../../lib/sessions/session-key.ts";

/** The session's direct children as the pane holds them. */
export type SubagentRoster = {
  subagentSessions?: readonly GatewaySessionRow[];
  /** True once the pane's own child query answered; seeded rows can be partial. */
  subagentSessionsHydrated?: boolean;
};

/** What a launch row needs to show its subagent's session and open it. */
export type SubagentRowContext = Pick<SubagentRoster, "subagentSessions"> & {
  onOpenSession?: (sessionKey: string) => void;
};

export type SpawnedSubagent = {
  /** The short name the launch call gave the subagent. */
  label: string;
  /** Its session, when the roster holds it; `runtimeMs` only once it finished. */
  session?: {
    key: string;
    running: boolean;
    runtimeMs: number | null;
    /** How it ended, when not by finishing its work. */
    ended?: "failed" | "stopped";
  };
};

type LaunchCard = Pick<ToolCard, "name" | "args" | "details" | "outputText">;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

// History keeps the result as text; only a live result still carries its details.
function launchedSessionKey(card: LaunchCard): string | undefined {
  return (
    text(asRecord(card.details)?.childSessionKey) ??
    text(safeParseJsonRecord(card.outputText ?? "")?.childSessionKey)
  );
}

/**
 * A `sessions_spawn` call that opened a session in its own right: asked for
 * with `visible`, or answered with a session that is not a subagent. Such a
 * launch is an ordinary operation, not a subagent's.
 */
function launchesOwnSession(card: LaunchCard): boolean {
  if (card.name.trim().toLowerCase() !== "sessions_spawn") {
    return false;
  }
  const childKey = launchedSessionKey(card);
  return (
    asRecord(card.args)?.visible === true ||
    (childKey !== undefined && !isSubagentSessionKey(childKey))
  );
}

/** The calls among `cards` that a count of subagents must leave out. */
export function ownSessionLaunchCalls(cards: readonly ToolCard[]): Set<string> {
  return new Set(
    cards.flatMap((card) => (card.callId && launchesOwnSession(card) ? [card.callId] : [])),
  );
}

/** The name a `sessions_spawn` call gave its subagent, shown instead of its assignment. */
export function spawnedSubagentLabel(card: LaunchCard): string | undefined {
  return card.name.trim().toLowerCase() === "sessions_spawn" && !launchesOwnSession(card)
    ? text(asRecord(card.args)?.label)
    : undefined;
}

/** A subagent that handed off to its own subagents is still at work. */
export function isUnfinishedSubagent(row: GatewaySessionRow): boolean {
  return isSessionRunActive(row) || row.hasActiveSubagentRun === true;
}

function finishedRuntimeMs(row: GatewaySessionRow): number | null {
  const { runtimeMs, startedAt, endedAt } = row;
  if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs) && runtimeMs >= 0) {
    return runtimeMs;
  }
  return typeof startedAt === "number" && typeof endedAt === "number" && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
}

function endedWithoutFinishing(row: GatewaySessionRow): "failed" | "stopped" | undefined {
  if (row.status === "failed" || row.status === "timeout") {
    return "failed";
  }
  return row.status === "killed" || row.status === "interrupted" ? "stopped" : undefined;
}

/**
 * Only the session its own result names is this launch's subagent. A launch
 * still in flight, or one that was refused, has none: its label alone can
 * belong to an earlier subagent or to a retry.
 */
export function resolveSpawnedSubagent(
  card: LaunchCard,
  rows: readonly GatewaySessionRow[] | undefined,
): SpawnedSubagent | null {
  const label = spawnedSubagentLabel(card);
  if (!label) {
    return null;
  }
  const childKey = launchedSessionKey(card);
  const row = childKey
    ? rows?.find((candidate) => areUiSessionKeysEquivalent(candidate.key, childKey))
    : undefined;
  if (!row) {
    return { label };
  }
  const running = isUnfinishedSubagent(row);
  const ended = running ? undefined : endedWithoutFinishing(row);
  return {
    label,
    session: {
      key: row.key,
      running,
      runtimeMs: running ? null : finishedRuntimeMs(row),
      ...(ended ? { ended } : {}),
    },
  };
}

const rosterKeys = new WeakMap<readonly GatewaySessionRow[], string>();

/**
 * Everything launch rows draw from the roster. Settled rows repaint when a
 * subagent starts or finishes, not when its activity patches or the roster's
 * order change.
 */
export function spawnedSubagentsRenderKey(rows: readonly GatewaySessionRow[] | undefined): string {
  if (!rows || rows.length === 0) {
    return "";
  }
  let key = rosterKeys.get(rows);
  if (key === undefined) {
    key = rows
      .map((row) => {
        const running = isUnfinishedSubagent(row);
        return JSON.stringify([
          row.key,
          running,
          running ? null : finishedRuntimeMs(row),
          running ? null : endedWithoutFinishing(row),
        ]);
      })
      .toSorted()
      .join("\n");
    rosterKeys.set(rows, key);
  }
  return key;
}
