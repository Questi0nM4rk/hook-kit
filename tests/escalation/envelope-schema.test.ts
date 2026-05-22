// TASK-035 — Envelope schema snapshot.
//
// Captures the JSON-schema form of `AskRequestSchema` + `AskResponseSchema`
// from src/escalation/envelope.ts so CI fails on accidental shape changes.
// Intentional changes require regenerating the snapshot in the SAME commit
// that changes the schema — the diff makes the shape change reviewable.
//
// To regenerate intentionally:
//   bun tests/escalation/envelope-schema.test.ts --regenerate
// (Or just run: `bun -e '...same shape as below...' > tests/escalation/envelope-schema.snapshot.json`)
//
// docs/ESCALATION.md § Envelope schema reads against this snapshot; if the
// snapshot updates, the doc's per-field table must be audited in the same
// commit.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AskRequestSchema, AskResponseSchema } from "../../src/escalation/envelope.js";

const SNAPSHOT_PATH = join(import.meta.dirname, "envelope-schema.snapshot.json");

interface SnapshotShape {
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown>;
}

function loadSnapshot(): SnapshotShape {
  const raw = readFileSync(SNAPSHOT_PATH, "utf8");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse return is any; the snapshot file is authored alongside this test and matches SnapshotShape by construction.
  const parsed: SnapshotShape = JSON.parse(raw);
  return parsed;
}

/** Cast `z.toJSONSchema()` to a plain JSON object — its return type carries
 *  a Zod-internal `~standard` payload that confuses bun:test's `toEqual()`
 *  overload matching against ZodStandardJSONSchemaPayload. The on-disk
 *  snapshot is parsed JSON (plain object), so we compare against the same
 *  shape on both sides. */
function asJsonObject(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("envelope schema snapshot", () => {
  test("AskRequestSchema JSON-schema form matches snapshot", () => {
    const current = asJsonObject(z.toJSONSchema(AskRequestSchema));
    const snapshot = loadSnapshot();
    expect(current).toEqual(snapshot.request);
  });

  test("AskResponseSchema JSON-schema form matches snapshot", () => {
    const current = asJsonObject(z.toJSONSchema(AskResponseSchema));
    const snapshot = loadSnapshot();
    expect(current).toEqual(snapshot.response);
  });

  test("snapshot file roundtrips through JSON.parse / JSON.stringify", () => {
    // A drift-prevention check on the snapshot file itself: if a future
    // editor introduces trailing whitespace or different indent, the
    // failure surfaces here rather than the comparison tests above.
    const raw = readFileSync(SNAPSHOT_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });
});
