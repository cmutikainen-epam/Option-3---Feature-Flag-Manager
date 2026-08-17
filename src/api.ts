import { Effect, Schema } from "effect";
import type { FeatureFlag } from "../shared/types.js";
import { ApiErrorSchema } from "../shared/errors.js";

const decodeApiError = Schema.decodeUnknownSync(ApiErrorSchema);

const request = <A>(input: RequestInfo, init?: RequestInit): Effect.Effect<A, string> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(input, init),
      catch: () => "Could not reach the server. Please check your connection and try again.",
    });
    const body: unknown = yield* Effect.tryPromise({
      try: () => res.json(),
      catch: () => "Could not decode JSON",
    });

    if (res.ok) {
      // TODO use schema validation on `A` so we dont have to cast
      return body as A;
    }

    return yield* decodeApiError(body);
  }).pipe(
    Effect.catchTags({
      BadRequestError: (error) => Effect.fail(error.message),
      UnknownFlagError: (error) => Effect.fail(error.message),
      ConflictError: () => Effect.fail("This flag changed elsewhere — refresh and try again."),
      DuplicateFlagError: (error) =>
        Effect.fail(`${error.message}. Please modify the name and try adding again`),
      DbError: () => Effect.fail("Could not reach Database, try again later"),
    }),
  );

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Fetch every feature flag. */
export const listFlags = (): Effect.Effect<readonly FeatureFlag[], string> =>
  request<readonly FeatureFlag[]>("/api/flags");

/** Check a flag value by name. `throttled` adds a 10-second delay before the lookup. */
export const getFlagByName = (name: string): Effect.Effect<boolean, string> =>
  request<boolean>(`/api/flags/check?name=${encodeURIComponent(name)}`);

/** Read a flag via BEGIN → read → sleep 10s → COMMIT. Returns the snapshot value read at BEGIN. */
export const getFlagByNameThrottledSequence = (name: string): Effect.Effect<boolean, string> =>
  request<boolean>(`/api/flags/throttled-read-sequence?name=${encodeURIComponent(name)}`);

/** Create a new feature flag with the given name (disabled by default). */
export const createFlag = (name: string): Effect.Effect<FeatureFlag, string> =>
  request<FeatureFlag>("/api/flags", jsonInit("POST", { name }));

/**
 * Enable or disable an existing flag. Requires the current version for
 * optimistic locking. `throttled` updates immediately but delays the
 * announce (and thus the response) by 10 seconds.
 */
export const setFlagEnabled = (
  id: number,
  enabled: boolean,
  version: number,
  throttled = false,
): Effect.Effect<FeatureFlag, string> =>
  request<FeatureFlag>(
    `/api/flags/${id}${throttled ? "?throttled=true" : ""}`,
    jsonInit("PATCH", { enabled, version }),
  );

/** Delete a feature flag by id. */
export const deleteFlag = (id: number): Effect.Effect<void, string> =>
  request<void>(`/api/flags/${id}`, { method: "DELETE" });

export const changeJournalMode = (mode: string): Effect.Effect<string, string> =>
  request<string>(`/api/journal-mode`, jsonInit('PATCH', { mode }))

export const getJournalMode = (): Effect.Effect<string, string> =>
  request<string>(`/api/journal-mode`, { method: 'GET' })
/** Callbacks driving a single streamed `/api/agent/chat` exchange. */
export interface AgentChatStreamHandlers {
  readonly onDelta: (text: string) => void;
  readonly onError: (message: string) => void;
  readonly onDone: () => void;
}

/**
 * Send one chat message about a flag to pi and stream the reply back token
 * by token over Server-Sent Events. Unlike the rest of this module, this
 * isn't Effect-based: the response is a stream of callback invocations over
 * time, not a single decoded value, so there's no single `A` for an
 * `Effect.Effect<A, string>` to resolve with. Returns a function that aborts
 * the in-flight request (e.g. on unmount or when the modal is closed).
 */
export const streamAgentChat = (
  flagName: string,
  message: string,
  handlers: AgentChatStreamHandlers,
): (() => void) => {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagName, message }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error("Could not reach the server. Please check your connection and try again.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; keep any trailing partial
        // event in the buffer until more bytes arrive.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const chunk of events) {
          let eventName = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
            else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
          }
          if (!data) continue;

          const parsed = JSON.parse(data) as { text?: string; message?: string };
          if (eventName === "delta" && typeof parsed.text === "string") {
            handlers.onDelta(parsed.text);
          } else if (eventName === "error") {
            handlers.onError(parsed.message ?? "Something unexpected happened.");
          } else if (eventName === "done") {
            handlers.onDone();
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onError(
        error instanceof Error ? error.message : "Could not reach the server. Please check your connection and try again.",
      );
    }
  })();

  return () => controller.abort();
};
