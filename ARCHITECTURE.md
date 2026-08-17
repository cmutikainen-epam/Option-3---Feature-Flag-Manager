# Agent Graph Architecture

## The split

There are exactly two responsibilities, in two locations:

| File | Role | Knows about |
|------|------|-------------|
| `shared/graph/index.ts` | **Generic graph library.** Defines `AgentGraph<S>`, `GraphBuilder<S>`, `NodeHandler`, etc. No flow logic. | Nothing flow-specific. Just types and a builder. |
| `shared/graph/flag-analysis.ts` | **One example flow: feature-flag analysis.** Uses `GraphBuilder` to construct a concrete graph. Owns its state shape, node handlers, topology. | Feature flags, jira, repos — but only inside this one flow. |
| `server/runAgentFlow.ts` | **Dumb generic runtime (`runGraph`).** Reads topology, runs ready nodes in parallel, joins on predecessors, follows transitions, stops at terminals. | *Nothing* flow-specific. Fully generic over `S`. |

The runtime doesn't import feature-flag logic and doesn't hardcode any stage, node name, or the number of nodes. You can hand it any `AgentGraph<S>` and it runs it.

## The model

```ts
// A node handler: given state, produce next state + which edges to follow.
type NodeHandler<S> = (state: S) => Effect<{
  state: S;
  transitions: readonly string[];   // [] = follow all outgoing edges
}>;

interface AgentNode<S> {
  kind: string;
  handler: NodeHandler<S>;
  terminal: boolean;
}

interface Transition { label: string; }   // edge payload

interface AgentGraph<S> {
  graph: Graph.DirectedGraph<AgentNode<S>, Transition>;
  initialState: S;
  onTerminal?: (kind: string, state: S) => Effect<void>;
}
```

A node owns:
- **its state logic** — how it mutates the shared `S`
- **its routing logic** — which outgoing edges to follow, by returning matching `transitions` labels (empty = follow all, used for linear/fan-out nodes)

## The runtime algorithm (`runGraph`)

1. Read topology once: for each node, its outgoing edges (`target` + `label`) and predecessors.
2. Enable all **source** nodes (no incoming edges).
3. Loop:
   - Compute **ready** nodes: enabled, not completed, and every predecessor that *actually routed to them* has completed. (This supports branching — an unused incoming edge never blocks a node.)
   - Run the ready batch **in parallel** (`Effect.forEach`, unbounded concurrency), all reading the same state snapshot.
   - Merge each result back into the state (independent key writes from concurrent branches all survive).
   - For each completed node, enable the successors whose edge label matches the node's `transitions` (or all successors if `transitions` is empty).
   - Stop when a **terminal** node is reached (invoking `onTerminal`).

## Building a flow

```ts
import { GraphBuilder } from "../shared/graph/index.js";

const graph = new GraphBuilder<MyState>()
  .node("start", startHandler)
  .node("work_a", handlerA)
  .node("work_b", handlerB)
  .node("join", joinHandler)
  .terminal("done")
  .edge("start", "work_a")
  .edge("start", "work_b")   // fan-out: start emits [] → both run in parallel
  .edge("work_a", "join")
  .edge("work_b", "join")    // fan-in: join waits for both
  .edge("join", "done")
  .build(initialState, (kind, state) => Effect.log(`terminal ${kind}`));

const finalState = yield* runGraph(graph);
```

**Branching**: a node returns `transitions: ["success"]` and only the outgoing edge labelled `"success"` is taken. Edge labels default to the target node's name, so `.edge("summarize", "fallback")` is followed when the node emits `transitions: ["fallback"]`.

## The example flow: feature-flag analysis

`shared/graph/flag-analysis.ts` exports `makeFeatureFlagGraph(flagName, callbacks)` which builds this topology:

```
        ┌─> check_jira ─┐
   start┤                ├─> summarize_findings ─┬─(success)─> success
        └─> check_repo ─┘                        └─(fallback)─> fallback ─┬─(success)─> success
                                                                          └─(failure)─> failure
```

- `check_jira` / `check_repo` run **in parallel** (both are successors of `start`, which emits `[]`).
- `summarize_findings` runs only after **both** complete (fan-in), then **branches** on risk (`success` vs `fallback`).
- `fallback` branches again (`success` vs `failure`).
- The graph's `onTerminal` dispatches to `callbacks.onSuccess` / `callbacks.onFailure`.

This is just one example. To build a different flow, write a new file and use the same `GraphBuilder` API — the runtime is untouched.

## Common tasks

| Task | Where |
|------|-------|
| Change what a node computes | Edit that node's handler in `shared/graph/flag-analysis.ts` |
| Change routing | Edit the handler's returned `transitions` |
| Change topology of the example | Edit `makeFeatureFlagGraph` (nodes/edges) in `shared/graph/flag-analysis.ts` |
| Add a brand-new flow | Create `shared/graph/your-flow-name.ts` with your own `make…Graph()`; call `runGraph` |
| Change how graphs execute (parallelism, joins, etc.) | Edit `runGraph` in `server/runAgentFlow.ts` — affects **all** flows |

## File structure

```
shared/graph/
  ├─ index.ts               Generic: GraphBuilder, AgentGraph, NodeHandler, etc.
  └─ flag-analysis.ts       Example: feature-flag analysis flow (state, handlers, topology)

server/
  └─ runAgentFlow.ts        Dumb runtime: runGraph() + re-exports for consumers

.pi/extensions/
  └─ flag-analysis.ts       Pi tool registration (uses runGraph + makeFeatureFlagGraph)
```

## Consumers

`.pi/extensions/flag-analysis.ts` uses the generic API directly:

```ts
import { makeFeatureFlagGraph } from "../../shared/graph/flag-analysis.js";
import { runGraph } from "../../server/runAgentFlow.js";

await Effect.runPromise(
  runGraph(makeFeatureFlagGraph(flagName, { onSuccess, onFailure }))
);
```

To build a new flow for a new tool:

```ts
// shared/graph/my-tool.ts
import { GraphBuilder } from "./index.js";

export interface MyState { /* ... */ }
export const makeMyToolGraph = (...): AgentGraph<MyState> =>
  new GraphBuilder<MyState>()
    .node("step1", handler1)
    // ...
    .build(initialState, onTerminal);

// .pi/extensions/my-tool.ts
import { makeMyToolGraph } from "../../shared/graph/my-tool.js";
import { runGraph } from "../../server/runAgentFlow.js";

pi.registerTool({
  // ...
  execute: async (...) => {
    await Effect.runPromise(runGraph(makeMyToolGraph(...)));
  },
});
```
