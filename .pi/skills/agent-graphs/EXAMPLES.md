# Examples

## 1. Minimal Linear Flow

```typescript
import { GraphBuilder } from "../shared/graph/index.js";
import { runGraph } from "../server/runAgentFlow.js";
import { Effect } from "effect";

interface CounterState {
  readonly count: number;
}

const graph = new GraphBuilder<CounterState>()
  .node("increment", (state) =>
    Effect.succeed({
      state: { count: state.count + 1 },
      transitions: [],
    })
  )
  .terminal("done")
  .edge("increment", "done")
  .build({ count: 0 });

const result = yield* runGraph(graph);
console.log(result.count); // 1
```

## 2. Parallel Processing

Two workers process in parallel, results merge:

```typescript
interface WorkState {
  readonly resultA?: number;
  readonly resultB?: number;
  readonly sum?: number;
}

const graph = new GraphBuilder<WorkState>()
  .node("start", (s) => Effect.succeed({ state: s, transitions: [] }))
  .node("workerA", (s) =>
    Effect.gen(function* () {
      yield* Effect.log("[workerA] computing...");
      // Simulate async work
      yield* Effect.sleep(100);
      return {
        state: { ...s, resultA: 10 },
        transitions: [],
      };
    })
  )
  .node("workerB", (s) =>
    Effect.gen(function* () {
      yield* Effect.log("[workerB] computing...");
      yield* Effect.sleep(50);
      return {
        state: { ...s, resultB: 20 },
        transitions: [],
      };
    })
  )
  .node("combine", (s) =>
    Effect.succeed({
      state: {
        ...s,
        sum: (s.resultA ?? 0) + (s.resultB ?? 0),
      },
      transitions: [],
    })
  )
  .terminal("done")
  .edge("start", "workerA")
  .edge("start", "workerB")  // fan-out
  .edge("workerA", "combine")
  .edge("workerB", "combine") // fan-in
  .edge("combine", "done")
  .build({});

const result = yield* runGraph(graph);
console.log(result.sum); // 30
```

## 3. Branching on Decision

```typescript
interface DecisionState {
  readonly input: number;
  readonly path?: "even" | "odd";
}

const graph = new GraphBuilder<DecisionState>()
  .node("decide", (s) =>
    Effect.succeed({
      state: {
        ...s,
        path: s.input % 2 === 0 ? "even" : "odd",
      },
      transitions: [s.input % 2 === 0 ? "even" : "odd"],
    })
  )
  .node("handleEven", (s) =>
    Effect.gen(function* () {
      yield* Effect.log(`[even] ${s.input} is even`);
      return { state: s, transitions: [] };
    })
  )
  .node("handleOdd", (s) =>
    Effect.gen(function* () {
      yield* Effect.log(`[odd] ${s.input} is odd`);
      return { state: s, transitions: [] };
    })
  )
  .terminal("done")
  .edge("decide", "handleEven", "even")
  .edge("decide", "handleOdd", "odd")
  .edge("handleEven", "done")
  .edge("handleOdd", "done")
  .build({ input: 42 });

const result = yield* runGraph(graph);
console.log(result.path); // "even"
```

## 4. Complex DAG with Multiple Branches

```typescript
interface AnalysisState {
  readonly dataA?: string;
  readonly dataB?: string;
  readonly summary?: string;
  readonly verdict?: "pass" | "fail";
}

const graph = new GraphBuilder<AnalysisState>()
  .node("start", (s) => Effect.succeed({ state: s, transitions: [] }))
  
  // Parallel data collection
  .node("collectA", (s) =>
    Effect.gen(function* () {
      yield* Effect.log("[collectA]");
      return {
        state: { ...s, dataA: "data_from_A" },
        transitions: [],
      };
    })
  )
  .node("collectB", (s) =>
    Effect.gen(function* () {
      yield* Effect.log("[collectB]");
      return {
        state: { ...s, dataB: "data_from_B" },
        transitions: [],
      };
    })
  )
  
  // Analysis (runs after both collect)
  .node("analyze", (s) =>
    Effect.gen(function* () {
      yield* Effect.log(
        `[analyze] ${s.dataA} + ${s.dataB}`
      );
      return {
        state: {
          ...s,
          summary: `Analyzed: ${s.dataA} and ${s.dataB}`,
        },
        transitions: [],
      };
    })
  )
  
  // Branching decision
  .node("decide", (s) =>
    Effect.succeed({
      state: s,
      transitions: [
        s.summary?.includes("error") ? "fail" : "pass",
      ],
    })
  )
  
  // Outcomes
  .terminal("pass")
  .terminal("fail")
  
  // Topology
  .edge("start", "collectA")
  .edge("start", "collectB")     // parallel
  .edge("collectA", "analyze")
  .edge("collectB", "analyze")   // fan-in
  .edge("analyze", "decide")
  .edge("decide", "pass", "pass")
  .edge("decide", "fail", "fail")
  
  .build({});

const result = yield* runGraph(graph);
console.log(result.verdict); // "pass"
```

## 5. Real-World: Feature Flag Analysis

See `shared/graph/flag-analysis.ts` for the complete production example.

Key aspects:
- Complex state shape with optional fields
- Multiple parallel stages
- Conditional branching on risk assessment
- Fallback remediation attempt
- Callback dispatch on terminal

## 6. Error Handling

Handlers can use `Effect.fail()` to propagate errors:

```typescript
interface RiskyState {
  readonly value?: number;
  readonly error?: string;
}

const graph = new GraphBuilder<RiskyState>()
  .node("risky", (s) =>
    Effect.gen(function* () {
      if (s.value === undefined) {
        return yield* Effect.fail(new Error("Missing value"));
      }
      return {
        state: s,
        transitions: [],
      };
    })
  )
  .terminal("done")
  .edge("risky", "done")
  .build({ value: 42 });

// runGraph propagates the error as Effect failure
```

## 7. Logging and Debugging

Use `Effect.log` throughout for visibility:

```typescript
const nodeWithLogging: NodeHandler<YourState> = (state) =>
  Effect.gen(function* () {
    yield* Effect.log(`[node] input: ${JSON.stringify(state)}`);
    
    const result = doWork(state);
    
    yield* Effect.log(`[node] output: ${JSON.stringify(result)}`);
    
    return { state: result, transitions: [] };
  });
```

Run with logging enabled:

```typescript
yield* Effect.provideLayer(
  runGraph(graph),
  Logger.pretty // or Logger.json
);
```

## Cheat Sheet

| Pattern | Code |
|---------|------|
| Linear flow | `.edge(a, b).edge(b, c)` |
| Parallel | `.edge(a, b).edge(a, c)` + `transitions: []` |
| Fan-in | `.edge(b, join).edge(c, join)` |
| Branch | `transitions: ["success"]` + `.edge(a, b, "success")` |
| Start | Any node with no incoming edges |
| Terminal | `.terminal(name)` |
| Done | Reach a terminal node |
