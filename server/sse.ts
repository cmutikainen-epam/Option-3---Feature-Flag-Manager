/**
 * SSE (Server-Sent Events) helpers for Effect-based routes.
 *
 * Routes that stream responses return a `Stream.Stream<SseEvent, ApiError>`
 * instead of a single `Effect.Effect<A, ApiError>`. `sseHandler` is the
 * parallel of the `handler` wrapper in index.ts: it sets the SSE response
 * headers, pipes the stream through the `Sse.encode` channel to produce
 * properly-framed SSE text, and maps any typed `ApiError` or defect to a
 * terminal `error` event so the client always receives a clean signal.
 */
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import type { Request, Response } from "express";
import type { ApiError } from "../shared/errors.js";

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

/** A token fragment streamed from the model. */
export interface SseDeltaEvent {
  readonly type: "delta";
  readonly text: string;
}

/** Signals successful end of stream. */
export interface SseDoneEvent {
  readonly type: "done";
}

/** Signals a terminal error; always the last event on a failed stream. */
export interface SseErrorEvent {
  readonly type: "error";
  readonly message: string;
}

export type SseEvent = SseDeltaEvent | SseDoneEvent | SseErrorEvent;

// ---------------------------------------------------------------------------
// Internal: convert a SseEvent to the Sse.Event wire shape
// ---------------------------------------------------------------------------

const toSseWireEvent = (event: SseEvent): Sse.Event => ({
  _tag: "Event",
  event: event.type,
  id: undefined,
  data: JSON.stringify(event),
});

// ---------------------------------------------------------------------------
// sseHandler
// ---------------------------------------------------------------------------

/**
 * Express route wrapper for SSE streaming routes.
 *
 * Mirrors the `handler` wrapper in index.ts but accepts a builder that
 * returns a `Stream<SseEvent, ApiError>` rather than a single Effect.
 *
 * - Sets `Content-Type: text/event-stream` and flushes headers immediately.
 * - Maps each `SseEvent` to a `Sse.Event` wire shape, then pipes through
 *   `Sse.encode` to produce properly-framed `text/event-stream` text chunks.
 * - On a typed `ApiError` failure, sends a terminal `error` event with the
 *   serialised error message before closing.
 * - On an unexpected defect, sends a generic `error` event before closing.
 * - Always ends the response when the stream terminates.
 */
export const sseHandler =
  (build: (req: Request) => Stream.Stream<SseEvent, ApiError>) =>
  (req: Request, res: Response): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Map domain events → properly-framed SSE text using the Sse encoder.
    const textStream: Stream.Stream<string, ApiError> = build(req).pipe(
      Stream.map((event) => Sse.encoder.write(toSseWireEvent(event))),
    );

    const program = Stream.runForEach(textStream, (text) =>
      Effect.sync(() => res.write(text)),
    );

    Effect.runPromiseExit(program).then((exit) => {
      if (Exit.isSuccess(exit)) {
        res.end();
        return;
      }

      // Map typed failure (ApiError) or defect to a terminal error event.
      const message = Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "Something unexpected happened. Please try again.",
        onSome: (error: ApiError) => error.message,
      });

      const errorEvent: SseErrorEvent = { type: "error", message };
      res.write(Sse.encoder.write(toSseWireEvent(errorEvent)));
      res.end();
    });
  };
