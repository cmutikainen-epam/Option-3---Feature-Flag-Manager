# API Reference

## Core Types

### `AgentGraph<S>`

The fully-specified graph your flow implements.

```typescript
interface AgentGraph<S> {
  readonly graph: Graph.DirectedGraph<AgentNode<S>, Transition>;
  readonly initialState: S;
  readonly onTerminal?: (kind: string, state: S) => Effect.Effect<void>;
}
```

### `AgentNode<S>`

A node in the graph. Carries its own handler and metadata.

```typescript
interface AgentNode<S> {
  readonly kind: string;           // node name (for logging / matching)
  readonly handler: NodeHandler<S>; // the behavior
  readonly terminal: boolean;       // is this a sink node?
}
```

### `NodeHandler<S>`

The function a node runs. Takes state, returns next state + routing.

```typescript
type NodeHandler<S> = (state: S) => Effect.Effect<NodeResult<S>>;

interface NodeResult<S> {
  readonly state: S;
  readonly transitions: readonly string[]; // edge labels to follow
}
```

### `NodeResult<S>`

The output of a handler.

```typescript
interface NodeResult<S> {
  readonly state: S;              // the (possibly updated) shared state
  readonly transitions: readonly string[];
}
```

`transitions` semantics:
- **Empty array `[]`**: Follow every outgoing edge (common for linear/fan-out)
- **Non-empty `["success"]`**: Only follow edges with label `"success"`

### `Transition`

Edge payload in the graph.

```typescript
interface Transition {
  readonly label: string;
}
```

Edge labels default to the target node's name when not specified.

### `GraphBuilder<S>`

Fluent builder for declaring nodes and edges.

```typescript
class GraphBuilder<S> {
  node(name: string, handler: NodeHandler<S>): this;
  terminal(name: string, handler?: NodeHandler<S>): this;
  edge(from: string, to: string, label?: string): this;
  build(
    initialState: S,
    onTerminal?: (kind: string, state: S) => Effect.Effect<void>
  ): AgentGraph<S>;
}
```

## Runtime

### `runGraph<S>(agentGraph: AgentGraph<S>): Effect.Effect<S>`

Executes the graph to completion. Returns the final accumulated state.

```typescript
const finalState = yield* runGraph(graph);
```

The runtime:
1. Reads the topology (nodes, edges, predecessors)
2. Enables source nodes (no incoming edges)
3. Loops:
   - Compute ready nodes (enabled, not completed, all routed predecessors done)
   - Run the batch in parallel
   - Merge state from concurrent branches
   - Enable successors based on emitted transitions
   - Stop if a terminal is reached

## Examples

### Simple Sequential Flow

```typescript
const graph = new GraphBuilder<{ count: number }>()
  .node("increment", (state) =>
    Effect.succeed({ state: { count: state.count + 1 }, transitions: [] })
  )
  .terminal("done")
  .edge("increment", "done")
  .build({ count: 0 });

const final = yield* runGraph(graph);
console.log(final.count); // 1
```

### Parallel Fan-Out/Fan-In

```typescript
const graph = new GraphBuilder<{ a?: string; b?: string; sum?: string }>()
  .node("start", (s) => Effect.succeed({ state: s, transitions: [] }))
  .node("taskA", (s) =>
    Effect.succeed({ state: { ...s, a: "A" }, transitions: [] })
  )
  .node("taskB", (s) =>
    Effect.succeed({ state: { ...s, b: "B" }, transitions: [] })
  )
  .node("join", (s) =>
    Effect.succeed({
      state: { ...s, sum: `${s.a}${s.b}` },
      transitions: [],
    })
  )
  .terminal("done")
  .edge("start", "taskA")
  .edge("start", "taskB")   // fan-out
  .edge("taskA", "join")
  .edge("taskB", "join")    // fan-in
  .edge("join", "done")
  .build({});

const final = yield* runGraph(graph);
console.log(final.sum); // "AB" (both A and B completed)
```

### Branching

```typescript
const graph = new GraphBuilder<{ path?: string }>()
  .node("decide", (s) =>
    Effect.succeed({
      state: s,
      transitions: [s.decision ? "yes" : "no"],
    })
  )
  .terminal("yes")
  .terminal("no")
  .edge("decide", "yes", "yes")     // only if "yes" transition
  .edge("decide", "no", "no")       // only if "no" transition
  .build({ decision: true });

const final = yield* runGraph(graph);
// Only "yes" terminal runs
```

### With Callbacks

```typescript
const graph = new GraphBuilder<{ status: string }>()
  .node("work", (s) =>
    Effect.succeed({
      state: { ...s, status: "done" },
      transitions: ["success"],
    })
  )
  .terminal("success")
  .edge("work", "success", "success")
  .build(
    { status: "pending" },
    (kind, state) =>
      Effect.gen(function* () {
        yield* Effect.log(`Terminal: ${kind}`);
        yield* Effect.log(`Final state: ${JSON.stringify(state)}`);
      })
  );

yield* runGraph(graph);
// Logs: Terminal: success
// Logs: Final state: {"status":"done"}
```

## Common Mistakes

### Mistake: Forgetting to return transitions

A handler must return both `state` AND `transitions`.

```typescript
// ❌ WRONG
const badHandler = (s) => Effect.succeed({ state: s });

// ✅ RIGHT
const goodHandler = (s) =>
  Effect.succeed({ state: s, transitions: [] });
```

### Mistake: Forgetting edge labels match transitions

When a node branches, its `transitions` must match the edge labels you declared.

```typescript
// ❌ WRONG
.node("decide", (s) =>
  Effect.succeed({
    state: s,
    transitions: ["route_a"],  // edge is labelled "success"!
  })
)
.edge("decide", "next", "success")

// ✅ RIGHT
.node("decide", (s) =>
  Effect.succeed({
    state: s,
    transitions: ["success"],
  })
)
.edge("decide", "next", "success")
```

### Mistake: Creating cycles in the DAG

The graph must be acyclic (directed acyclic graph). Cycles cause deadlock.

```typescript
// ❌ WRONG
.edge("a", "b")
.edge("b", "c")
.edge("c", "a")  // cycle!

// ✅ RIGHT
.edge("a", "b")
.edge("b", "c")
.edge("c", "terminal")
```

### Mistake: Not merging state correctly in parallel branches

If two parallel nodes write the *same* key, last-merge wins. Use distinct keys:

```typescript
// ❌ SUBOPTIMAL (log collision on concurrent write)
.node("taskA", (s) =>
  Effect.succeed({
    state: { ...s, log: [...s.log, "A"] },
    transitions: [],
  })
)
.node("taskB", (s) =>
  Effect.succeed({
    state: { ...s, log: [...s.log, "B"] },  // both write 'log'
    transitions: [],
  })
)

// ✅ BETTER (use distinct keys if order matters)
.node("taskA", (s) =>
  Effect.succeed({
    state: { ...s, resultA: "..." },
    transitions: [],
  })
)
.node("taskB", (s) =>
  Effect.succeed({
    state: { ...s, resultB: "..." },
    transitions: [],
  })
)
```
