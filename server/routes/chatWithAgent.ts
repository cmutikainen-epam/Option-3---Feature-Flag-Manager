import { join } from "node:path";
import type { Request } from "express";
import { Cause, Effect, Queue, Stream } from "effect";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BadRequestError } from "../../shared/errors.js";
import type { SseEvent } from "../sse.js";

/**
 * POST /api/agent/chat — chat with pi about a single feature flag.
 *
 * Each request is a fresh, stateless conversation: no history is kept across
 * requests, so the client sends the full context (flag name + the user's
 * message) every time and we spin up a brand-new in-memory AgentSession with
 * no filesystem/bash tools enabled (this is a plain Q&A assistant, not a
 * coding agent). The response is a `Stream<SseEvent, ApiError>` consumed by
 * `sseHandler`, which sets the SSE headers and writes events as they arrive.
 *
 * Uses the project's own `.pi/agent/models.json`
 */

// Cached across requests: discovering/reloading model config on every chat
// message would add needless latency, and the runtime is otherwise stateless
// aside from provider/model catalog info.
let modelRuntimePromise: Promise<ModelRuntime> | undefined;

const getModelRuntime = (): Promise<ModelRuntime> => {
  modelRuntimePromise ??= ModelRuntime.create({
    modelsPath: join(process.cwd(), ".pi/agent/models.json"),
  });
  return modelRuntimePromise;
};

const PROVIDER_ID = "anthropic-proxy";
const MODEL_ID = "claude-sonnet-4-6";

/** POST /api/agent/chat — body: `{ flagName: string, message: string }`. */
export const chatWithAgent = (req: Request): Stream.Stream<SseEvent, BadRequestError> => {
  const body = req.body as { flagName?: unknown; message?: unknown };

  if (typeof body.flagName !== "string" || body.flagName.trim().length === 0) {
    return Stream.fail(
      new BadRequestError({ message: "`flagName` must be a non-empty string" }),
    );
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return Stream.fail(
      new BadRequestError({ message: "`message` must be a non-empty string" }),
    );
  }

  const flagName = body.flagName.trim();
  const message = body.message.trim();

  return Stream.callback<SseEvent, BadRequestError>((queue) =>
    Effect.gen(function* () {
      const modelRuntime = yield* Effect.promise(() => getModelRuntime());
      const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);

      if (!model) {
        Queue.failCauseUnsafe(
          queue,
          Cause.die(
            new Error(
              `Model "${MODEL_ID}" is not configured on provider "${PROVIDER_ID}".`,
            ),
          ),
        );
        return;
      }

      // Build a loader that discovers the project-local extension in
      // .pi/extensions/ (which registers the `analyze_feature_flag` tool)
      // while keeping all built-in filesystem/bash tools disabled.
      const cwd = process.cwd();
      const agentDir = join(cwd, ".pi");
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        systemPromptOverride: () =>
          `You are "pi", a helpful assistant embedded in a feature flag manager UI. ` +
          `The user is asking about a specific feature flag named "${flagName}". ` +
          `You have access to the analyze_feature_flag tool — use it whenever the user asks ` +
          `about dependencies, conflicts, related work, or whether this flag is safe to enable. ` +
          `Answer concisely and stay on topic.`,
      });
      yield* Effect.promise(() => loader.reload());

      const created = yield* Effect.promise(() =>
        createAgentSession({
          modelRuntime,
          model,
          sessionManager: SessionManager.inMemory(),
          // Disable all built-in tools (read, bash, edit, write, …) but keep
          // extension-registered tools (analyze_feature_flag) active.
          noTools: "builtin",
          resourceLoader: loader,
        }),
      );

      const session = created.session;

      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          Queue.offerUnsafe(queue, { type: "delta", text: event.assistantMessageEvent.delta });
        }
      });

      yield* Effect.promise(() => session.prompt(message));

      Queue.offerUnsafe(queue, { type: "done" });
      Queue.endUnsafe(queue);

      session.dispose();
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.sync(() => {
          Queue.failCauseUnsafe(
            queue,
            Cause.die(error instanceof Error ? error : new Error(String(error))),
          );
        }),
      ),
    ),
  );
};
