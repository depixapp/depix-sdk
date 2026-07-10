// Test doubles for the Pix-flow suites (not a *.test.ts — not collected).
import type { FetchLike, FetchResponseLike } from "../../src/api/client.js";

export interface MockResponseSpec {
  status?: number; // default 200
  json?: unknown; // serialized to text (ignored when `text` is set)
  text?: string; // raw body text
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function toResponse(spec: MockResponseSpec): FetchResponseLike {
  const status = spec.status ?? 200;
  const body = spec.text !== undefined ? spec.text : spec.json !== undefined ? JSON.stringify(spec.json) : "";
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers.set(k.toLowerCase(), v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body
  };
}

export interface MockFetch {
  fetch: FetchLike;
  calls: RecordedRequest[];
}

/**
 * A FetchLike returning canned responses. Pass an array (consumed in order; the
 * LAST entry repeats once exhausted, so retry loops keep getting it) or a
 * function of the recorded request. A `null`/throwing spec simulates a network
 * error.
 */
export function mockFetch(
  responses: MockResponseSpec[] | ((req: RecordedRequest) => MockResponseSpec | null)
): MockFetch {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    const req: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body
    };
    calls.push(req);
    let spec: MockResponseSpec | null;
    if (typeof responses === "function") {
      spec = responses(req);
    } else {
      spec = responses[Math.min(index, responses.length - 1)] ?? null;
      index++;
    }
    if (spec === null) throw new Error("simulated network error");
    return toResponse(spec);
  };
  return { fetch, calls };
}

/**
 * A fake clock whose sleep() ADVANCES now — throttle windows expire and retry
 * backoffs return immediately, so time-dependent code is deterministic and
 * never blocks the test.
 */
export function fakeClock(startMs = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    }
  };
}
