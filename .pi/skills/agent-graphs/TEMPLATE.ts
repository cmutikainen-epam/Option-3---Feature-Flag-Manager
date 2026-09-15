/**
 * shared/graph/TEMPLATE.ts
 *
 * Template for building a new agent flow.
 *
 * Steps:
 * 1. Copy this file to shared/graph/your-tool-name.ts
 * 2. Replace "YourState", handlers, and topology with your logic
 * 3. Export your makeYourToolGraph() function
 * 4. Use it in .pi/extensions/your-tool.ts or server code
 */

import { Effect } from "effect";
import { GraphBuilder, type AgentGraph, type NodeHandler } from "./index.js";

// ---------------------------------------------------------------------------
// State Shape
// ---------------------------------------------------------------------------

export interface YourState {
  readonly input: string;
  readonly step1Result?: string;
  readonly step2Result?: string;
  readonly verdict?: "success" | "failure";
}

// ---------------------------------------------------------------------------
// Node Handlers
// ---------------------------------------------------------------------------

const startNode: NodeHandler<YourState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log("[start]");
    return { state, transitions: [] };
  });

const step1Node: NodeHandler<YourState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[step1] processing: ${state.input}`);
    // TODO: implement your logic
    const result = `step1_${state.input}`;
    return {
      state: { ...state, step1Result: result },
      transitions: [],
    };
  });

const step2Node: NodeHandler<YourState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[step2] with ${state.step1Result}`);
    // TODO: implement your logic
    const result = `step2_${state.step1Result}`;
    return {
      state: { ...state, step2Result: result },
      transitions: [],
    };
  });

const decideNode: NodeHandler<YourState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log("[decide]");
    // TODO: implement your decision logic
    const isSuccess = (state.step2Result?.length ?? 0) > 5;
    return {
      state,
      transitions: [isSuccess ? "success" : "failure"],
    };
  });

const terminalNode = (verdict: "success" | "failure"): NodeHandler<YourState> => (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[${verdict}] TERMINAL`);
    return {
      state: { ...state, verdict },
      transitions: [],
    };
  });

// ---------------------------------------------------------------------------
// Callbacks (optional)
// ---------------------------------------------------------------------------

export interface YourCallbacks {
  readonly onSuccess?: (state: YourState) => Effect.Effect<void>;
  readonly onFailure?: (state: YourState) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Graph Factory
// ---------------------------------------------------------------------------

export const makeYourToolGraph = (
  input: string,
  callbacks?: YourCallbacks,
): AgentGraph<YourState> =>
  new GraphBuilder<YourState>()
    .node("start", startNode)
    .node("step1", step1Node)
    .node("step2", step2Node)
    .node("decide", decideNode)
    .terminal("success", terminalNode("success"))
    .terminal("failure", terminalNode("failure"))
    .edge("start", "step1")
    .edge("step1", "step2")
    .edge("step2", "decide")
    .edge("decide", "success", "success")
    .edge("decide", "failure", "failure")
    .build({ input }, (kind, state) => {
      if (kind === "success" && callbacks?.onSuccess) {
        return callbacks.onSuccess(state);
      } else if (kind === "failure" && callbacks?.onFailure) {
        return callbacks.onFailure(state);
      }
      return Effect.void;
    });
