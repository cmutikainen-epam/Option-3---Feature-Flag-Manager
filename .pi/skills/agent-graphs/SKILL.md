---
name: agent-graphs
description: Design and build DAG-based agent flows using generic graph primitives. Each flow defines its own state shape, node handlers, and topology. The runtime is completely generic and agnostic to flow logic.
---

# Agent Graphs

Build sophisticated multi-node DAG flows where nodes run in parallel, synchronize on predecessors, and route based on computed outcomes.

## Quick Start

### 1. Import the generic library

```typescript
import { GraphBuilder, type AgentGraph } from "../shared/graph/index.js";
import { runGraph } from "../server/runAgentFlow.js";
```

### 2. Define your state shape

```typescript
interface MyState {
  readonly input: string;
  readonly result?: string;
  readonly error?: string;
}
```

### 3. Define node handlers

Each handler takes the current state, mutates it, and decides which edges to follow next.

```typescript
const nodeA: NodeHandler<MyState> = (state) =>
  Effect.gen(function* () {
    const value = doSomething(state.input);
    return {
      state: { ...state, intermediate: value },
      transitions: [], // [] = follow all outgoing edges
    };
  });

const nodeB: NodeHandler<MyState> = (state) =>
  Effect.gen(function* () {
    const ok = value > threshold;
    return {
      state: { ...state, result: ok ? "success" : "failed" },
      transitions: [ok ? "success" : "failure"], // branch on outcome
    };
  });
```

### 4. Build the graph

```typescript
const graph = new GraphBuilder<MyState>()
  .node("a", nodeA)
  .node("b", nodeB)
  .terminal("success")
  .terminal("failure")
  .edge("a", "b")
  .edge("b", "success", "success")     // only if nodeB emits "success"
  .edge("b", "failure", "failure")     // only if nodeB emits "failure"
  .build(
    { input: "..." },  // initial state
    (kind, state) => {
      // Called when a terminal is reached
      console.log(`Reached terminal: ${kind}`);
    }
  );
```

### 5. Run it

```typescript
const finalState = yield* runGraph(graph);
console.log(finalState);
```

## Parallel Execution & Fan-In/Out

Nodes that emit empty `transitions: []` enable *all* their successors to run. This creates fan-out:

```typescript
const graph = new GraphBuilder<MyState>()
  .node("start", startHandler)
  .node("taskA", handlerA)
  .node("taskB", handlerB)
  .node("join", joinHandler)   // waits for both A and B
  .terminal("done")
  .edge("start", "taskA")
  .edge("start", "taskB")       // start emits [] → both run in parallel
  .edge("taskA", "join")
  .edge("taskB", "join")        // join runs only after both complete
  .edge("join", "done")
  .build(...);
```

The runtime:
- Enables `taskA` and `taskB` after `start` completes
- Runs them in parallel (they read the same state snapshot)
- Merges their independent state writes
- Only enables `join` after both have completed

## Branching

A node can branch by emitting transition labels that match only certain outgoing edges:

```typescript
const graph = new GraphBuilder<MyState>()
  .node("decide", (state) =>
    Effect.gen(function* () {
      const path = state.risky ? "risky" : "safe";
      return { state, transitions: [path] };
    })
  )
  .node("riskyPath", riskyHandler)
  .node("safePath", safeHandler)
  .edge("decide", "riskyPath", "risky")   // label must match transition
  .edge("decide", "safePath", "safe")
  .build(...);
```

Now only `riskyPath` or `safePath` runs (not both), based on the decision node's output.

## Common Patterns

### Sequential Pipeline

Each node has one output edge; each handler emits `[]`.

```
a → b → c → d → terminal
```

### Fan-Out (Parallel Work)

One node feeds many; all emit `[]`.

```
     ├─→ taskA ─┐
start┼─→ taskB ─┼→ join → terminal
     └─→ taskC ─┘
```

### Conditional Branching

A decision node emits a specific transition label.

```
      ┌──(success)→ success
decide┤
      └──(failure)→ fallback → (...) → failure
```

### Complex DAG

Arbitrary topology, mixing patterns:

```
     ┌─→ check_a ─┐
start┤             ├─→ merge ─┬─(ok)─→ done
     └─→ check_b ─┘           └─(bad)→ remediate → done
```

## Example: The Feature-Flag Analysis Flow

See `shared/graph/flag-analysis.ts` for a complete example:

```typescript
export const makeFeatureFlagGraph = (
  flagName: string,
  callbacks: FlowCallbacks,
): AgentGraph<FlowState> =>
  new GraphBuilder<FlowState>()
    .node("start", startNode)
    .node("check_jira", checkJiraNode)
    .node("check_repo", checkRepoNode)
    .node("summarize_findings", summarizeNode)
    .node("fallback", fallbackNode)
    .terminal("success", terminal("success"))
    .terminal("failure", terminal("failure"))
    // Topology
    .edge("start", "check_jira")
    .edge("start", "check_repo")           // parallel
    .edge("check_jira", "summarize_findings")
    .edge("check_repo", "summarize_findings")
    // Branching
    .edge("summarize_findings", "success", "success")
    .edge("summarize_findings", "fallback", "fallback")
    .edge("fallback", "success", "success")
    .edge("fallback", "failure", "failure")
    .build({ flagName }, (kind, state) => {
      if (kind === "success" && state.summary) {
        yield* callbacks.onSuccess(state, state.summary);
      } else if (kind === "failure" && state.fallback) {
        yield* callbacks.onFailure(state, state.fallback);
      }
    });
```

The topology:
- `check_jira` and `check_repo` run in parallel (both follow `start`'s empty `transitions`)
- `summarize_findings` waits for both to complete (fan-in)
- Branches on risk level (`success` vs `fallback`)
- `fallback` optionally branches again (`success` vs `failure`)
- Terminates with callback dispatch

## How the Runtime Works

See `server/runAgentFlow.ts` for the complete implementation. High level:

1. **Read topology** from the effect `Graph` (nodes, edges, predecessors)
2. **Enable sources** (nodes with no incoming edges)
3. **Loop:**
   - Compute **ready** nodes: enabled, not yet run, and every predecessor that *routed to them* has completed
   - Run the batch **in parallel** (`Effect.forEach`, unbounded concurrency)
   - Each node starts from the same state snapshot
   - Merge independent state writes from concurrent branches
   - Enable successors based on each node's emitted `transitions`
   - Stop if a terminal node is reached (invoke `onTerminal`)

The runtime is **completely generic**: it knows nothing about your state shape, node names, or business logic. Hand it any `AgentGraph<S>` and it executes it correctly.

## Building a New Flow

Create a new file in `shared/graph/`:

```typescript
// shared/graph/my-tool.ts

import { GraphBuilder, type AgentGraph } from "./index.js";

export interface MyState {
  // your state fields
}

export const makeMyToolGraph = (...): AgentGraph<MyState> =>
  new GraphBuilder<MyState>()
    .node("node1", handler1)
    .node("node2", handler2)
    // ...
    .build(initialState, onTerminal);
```

Register it as a pi tool or extension:

```typescript
// .pi/extensions/my-tool.ts

import { makeMyToolGraph } from "../../shared/graph/my-tool.js";
import { runGraph } from "../../server/runAgentFlow.js";

pi.registerTool({
  name: "my_tool",
  execute: async (...) => {
    const graph = makeMyToolGraph(...);
    const result = await Effect.runPromise(runGraph(graph));
    return { result };
  },
});
```

## Files

| File | Role |
|------|------|
| `shared/graph/index.ts` | Generic library: `GraphBuilder`, `AgentGraph`, `NodeHandler`, etc. |
| `shared/graph/*.ts` | Concrete flows: `flag-analysis.ts`, `my-tool.ts`, etc. |
| `server/runAgentFlow.ts` | Generic runtime: `runGraph()` + re-exports |

## Debugging

Use `Effect.log` in handlers to trace execution:

```typescript
const myNode: NodeHandler<MyState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[myNode] processing: ${JSON.stringify(state)}`);
    const result = doWork(state);
    yield* Effect.log(`[myNode] result: ${JSON.stringify(result)}`);
    return { state: { ...state, ...result }, transitions: [] };
  });
```

The runtime also logs batch execution:

```
[runtime] running 2 node(s) in parallel
[runtime] running 1 node(s) in parallel
```

## References

- **Effect:** https://effect.run/ — async orchestration, used by handlers and runtime
- **Agent Skills standard:** https://agentskills.io/specification
- **Directed acyclic graphs:** https://en.wikipedia.org/wiki/Directed_acyclic_graph
