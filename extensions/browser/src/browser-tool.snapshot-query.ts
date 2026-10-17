/**
 * The snapshot `query` rule: which outline lines a query hands the model.
 *
 * A query is whitespace-separated words, matched case-insensitively as substrings. The rule
 * tries three ways in turn and the first that finds lines wins:
 * - `line`: lines holding every word, in page order;
 * - `window`: blocks of nearby lines that hold every word between them, each word within
 *   `SNAPSHOT_QUERY_WINDOW_LINES` adjacent lines, the blocks in page order;
 * - `some`: lines holding some of the words, most words first, then page order.
 * `none` means no line holds any word.
 */

/** Which way a snapshot query matched; the recorder writes it to the capture's `meta.json`. */
export type SnapshotQueryMatch = "line" | "window" | "some" | "none";

/**
 * The span of adjacent outline lines a `window` match may draw its words from. The role outline
 * puts every accessibility node on its own line and repeats a named element's text as a
 * `StaticText` child line beneath it, with unnamed wrappers (`paragraph`, `generic`, `listitem`)
 * on lines of their own; a heading and the first text under it, a label and its control, or a
 * sentence split by a link or a bold word sit within five lines, while the next section or card
 * usually starts further away.
 */
export const SNAPSHOT_QUERY_WINDOW_LINES = 5;

export type SnapshotQueryResult = {
  match: SnapshotQueryMatch;
  /** The lines handed to the model; a blank line separates the blocks of a `window` match. */
  text: string;
  /** Outline lines in `text`, block separators excluded. */
  lineCount: number;
  /** The model-facing line ahead of the matches, saying which way they matched. */
  summary: string;
};

type HeldLine = { line: string; index: number; words: number[] };

function coveringBlocks(held: HeldLine[], wordCount: number): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (const first of held) {
    if (first.words.length === 0) {
      continue;
    }
    const seen = new Set<number>();
    for (const next of held.slice(first.index, first.index + SNAPSHOT_QUERY_WINDOW_LINES)) {
      for (const word of next.words) {
        seen.add(word);
      }
      if (seen.size < wordCount) {
        continue;
      }
      const previous = blocks.at(-1);
      // Overlapping or touching windows read as one block of contiguous lines.
      if (previous && first.index <= previous[1] + 1) {
        previous[1] = Math.max(previous[1], next.index);
      } else {
        blocks.push([first.index, next.index]);
      }
      break;
    }
  }
  return blocks;
}

/** Match a query against an outline, `sourceTruncated` when the outline was cut before it. */
export function matchSnapshotQuery(params: {
  source: string;
  query: string;
  sourceTruncated?: boolean;
}): SnapshotQueryResult {
  const words = [...new Set(params.query.toLowerCase().split(/\s+/).filter(Boolean))];
  const lines = params.source.split("\n");
  const held: HeldLine[] = lines.map((line, index) => {
    const lower = line.toLowerCase();
    return {
      line,
      index,
      words: words.flatMap((word, wordIndex) => (lower.includes(word) ? [wordIndex] : [])),
    };
  });
  const where = `the returned snapshot${params.sourceTruncated ? " (source truncated)" : ""}`;

  const full = held
    .filter((entry) => entry.words.length === words.length)
    .map((entry) => entry.line);
  if (full.length > 0) {
    return {
      match: "line",
      text: full.join("\n"),
      lineCount: full.length,
      summary: `${full.length} matching line(s) in ${where}.`,
    };
  }

  const blocks = words.length > 1 ? coveringBlocks(held, words.length) : [];
  if (blocks.length > 0) {
    const blockLines = blocks.map(([from, to]) => lines.slice(from, to + 1));
    const lineCount = blockLines.reduce((sum, block) => sum + block.length, 0);
    return {
      match: "window",
      text: blockLines.map((block) => block.join("\n")).join("\n\n"),
      lineCount,
      summary:
        `No single line holds every word; nearby lines hold them all, each word within ` +
        `${SNAPSHOT_QUERY_WINDOW_LINES} adjacent lines: ${lineCount} line(s) in ${blocks.length} ` +
        `block(s) in ${where}${blocks.length > 1 ? ", a blank line between blocks" : ""}.`,
    };
  }

  const some = held
    .filter((entry) => entry.words.length > 0)
    .toSorted((a, b) => b.words.length - a.words.length || a.index - b.index);
  if (some.length > 0) {
    const groups = new Map<number, number>();
    for (const entry of some) {
      groups.set(entry.words.length, (groups.get(entry.words.length) ?? 0) + 1);
    }
    const found = new Set(some.flatMap((entry) => entry.words));
    const absent = words.filter((_, wordIndex) => !found.has(wordIndex));
    const counts = [...groups].map(
      ([count, lineTotal]) => `${lineTotal} with ${count} of ${words.length}`,
    );
    return {
      match: "some",
      text: some.map((entry) => entry.line).join("\n"),
      lineCount: some.length,
      summary:
        `Partial match: no line, and no ${SNAPSHOT_QUERY_WINDOW_LINES} adjacent lines, in ${where} ` +
        `hold all ${words.length} words. ${some.length} line(s) hold some of them, most first: ` +
        `${counts.join(", ")}.` +
        (absent.length > 0
          ? ` On no line: ${absent.map((word) => JSON.stringify(word)).join(", ")}.`
          : ""),
    };
  }

  return {
    match: "none",
    text: "",
    lineCount: 0,
    summary: `No matching lines in ${where}. Refine the query or take a broader snapshot.`,
  };
}
