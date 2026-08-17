/**
 * server/runAgentFlow.ts
 *
 * A DUMB, GENERIC graph runtime.
 *
 * It runs *any* `AgentGraph<S>`:
 *   1. Read the topology (nodes + labelled edges).
 *   2. Start from the source nodes (no incoming edges).
 *   3. A node becomes "ready" once every predecessor that actually routes to
 *      it has completed. Ready nodes run in parallel.
 *   4. When a node finishes it returns `{ state, transitions }`. The runtime
 *      merges the state and enables the outgoing edges the node selected
 *      (empty `transitions` = follow all outgoing edges).
 *   5. Stop when a terminal node is reached.
 *
 * The runtime knows nothing about jira, repos, fallbacks, feature flags, or the
 * shape of `S`. All of that lives in the graph the caller passes in.
 */

import { Effect, Graph, Option } from "effect";
import type { AgentGraph, AgentNode, Transition } from "../shared/graph/index.js";

// Re-export the flow-building API + types so existing callers keep a single,
// stable import surface (`server/runAgentFlow.js`).
export { GraphBuilder } from "../shared/graph/index.js";
export type {
  AgentGraph,
  AgentNode,
  NodeHandler,
  NodeResult,
  Transition,
} from "../shared/graph/index.js";
export type {
  FlowState,
  FlowCallbacks,
  CheckJiraResult,
  CheckRepoResult,
  SummaryResult,
  FallbackResult,
} from "../shared/graph/flag-analysis.js";
export type {
  StakeholderAlertState,
  StakeholderAlertCallbacks,
  AlertResult,
} from "../shared/graph/stakeholder-alert.js";

// ---------------------------------------------------------------------------
// Topology helpers (pure reads over the effect Graph)
// ---------------------------------------------------------------------------

interface Topology<S> {
  readonly graph: Graph.DirectedGraph<AgentNode<S>, Transition>;
  readonly nodeIndices: readonly Graph.NodeIndex[];
  /** node → its outgoing edges (target + label). */
  readonly outgoing: ReadonlyMap<
    Graph.NodeIndex,
    ReadonlyArray<{ target: Graph.NodeIndex; label: string }>
  >;
  /** node → its predecessors (source nodes of incoming edges). */
  readonly predecessors: ReadonlyMap<Graph.NodeIndex, ReadonlyArray<Graph.NodeIndex>>;
}

const readTopology = <S>(
  graph: Graph.DirectedGraph<AgentNode<S>, Transition>,
): Topology<S> => {
  const count = Graph.nodeCount(graph);
  const nodeIndices: Graph.NodeIndex[] = [];
  const outgoing = new Map<
    Graph.NodeIndex,
    Array<{ target: Graph.NodeIndex; label: string }>
  >();
  const predecessors = new Map<Graph.NodeIndex, Array<Graph.NodeIndex>>();

  for (let i = 0; i < count; i++) {
    const idx = i as Graph.NodeIndex;
    nodeIndices.push(idx);
    outgoing.set(idx, []);
    if (!predecessors.has(idx)) predecessors.set(idx, []);

    for (const edgeIdx of Graph.outgoingEdges(graph, idx)) {
      const edge = Graph.getEdge(graph, edgeIdx);
      if (Option.isNone(edge)) continue;
      const { target, data } = edge.value;
      outgoing.get(idx)!.push({ target, label: data.label });
      const preds = predecessors.get(target) ?? [];
      preds.push(idx);
      predecessors.set(target, preds);
    }
  }

  return { graph, nodeIndices, outgoing, predecessors };
};

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/**
 * Execute an arbitrary agent graph to completion (or until a terminal node is
 * reached). Returns the final accumulated state.
 */
export const runGraph = <S>(agentGraph: AgentGraph<S>): Effect.Effect<S> =>
  Effect.scoped(
    Effect.gen(function* () {
      const topo = readTopology(agentGraph.graph);

      let state = agentGraph.initialState;

      // Nodes we've decided should run (an incoming edge routed to them, or
      // they're a source). Sources are enabled up front.
      const enabled = new Set<Graph.NodeIndex>();
      const completed = new Set<Graph.NodeIndex>();
      // Which predecessors actually routed to a given node (only these must
      // complete before the node is ready — supports branching where some
      // incoming edges are never taken).
      const arrivedFrom = new Map<Graph.NodeIndex, Set<Graph.NodeIndex>>();

      for (const idx of topo.nodeIndices) {
        if ((topo.predecessors.get(idx) ?? []).length === 0) {
          enabled.add(idx);
        }
      }

      // A node is ready when it's enabled, not yet completed, and every
      // predecessor that routed to it has completed.
      const readyNodes = (): Graph.NodeIndex[] =>
        [...enabled].filter((idx) => {
          if (completed.has(idx)) return false;
          const arrived = arrivedFrom.get(idx);
          // Sources have no arrivals; they're ready immediately.
          if (!arrived || arrived.size === 0) {
            return (topo.predecessors.get(idx) ?? []).length === 0;
          }
          return [...arrived].every((p) => completed.has(p));
        });

      while (true) {
        const batch = readyNodes();
        if (batch.length === 0) break;

        yield* Effect.log(`[runtime] running ${batch.length} node(s) in parallel`);

        // All nodes in a batch read the same snapshot of `state` and run
        // concurrently. `Effect.forEach` with unbounded concurrency forks a
        // fiber per node and collects every result (unlike a FiberMap, which
        // removes fibers as soon as they complete).
        const snapshot = state;
        const results = yield* Effect.forEach(
          batch,
          (idx) =>
            Effect.gen(function* () {
              const node = Graph.getNode(topo.graph, idx);
              if (Option.isNone(node)) {
                return {
                  idx,
                  state: snapshot,
                  transitions: [] as readonly string[],
                };
              }
              const result = yield* node.value.handler(snapshot);
              return { idx, state: result.state, transitions: result.transitions };
            }),
          { concurrency: "unbounded" },
        );

        // Merge state. For a parallel batch each handler returned the full
        // state derived from the same snapshot; we fold them so independent
        // writes from concurrent branches are all retained.
        for (const r of results) {
          state = mergeState(snapshot, state, r.state);
          completed.add(r.idx);
        }

        // Route: enable successors according to each node's transitions.
        let hitTerminal = false;
        for (const r of results) {
          const node = Graph.getNode(topo.graph, r.idx);
          if (Option.isNone(node)) continue;

          if (node.value.terminal) {
            hitTerminal = true;
            if (agentGraph.onTerminal) {
              yield* agentGraph.onTerminal(node.value.kind, state);
            }
            continue;
          }

          const outs = topo.outgoing.get(r.idx) ?? [];
          const follow =
            r.transitions.length === 0
              ? outs // no explicit choice → follow every outgoing edge
              : outs.filter((o) => r.transitions.includes(o.label));

          for (const o of follow) {
            enabled.add(o.target);
            const arrived = arrivedFrom.get(o.target) ?? new Set<Graph.NodeIndex>();
            arrived.add(r.idx);
            arrivedFrom.set(o.target, arrived);
          }
        }

        if (hitTerminal) break;
      }

      return state;
    }),
  );

/**
 * Merge state produced by (possibly concurrent) handlers.
 *
 * Each handler in a batch started from `base`. We compare each handler's output
 * to `base` and apply only the keys it actually changed on top of `acc`. This
 * means two parallel branches that each set a different field (e.g. `checkJira`
 * and `checkRepo`) both survive, without one clobbering the other.
 */
const mergeState = <S>(base: S, acc: S, next: S): S => {
  if (typeof next !== "object" || next === null) return next;
  if (typeof base !== "object" || base === null) return next;

  const result: Record<string, unknown> = { ...(acc as Record<string, unknown>) };
  const baseRec = base as Record<string, unknown>;
  const nextRec = next as Record<string, unknown>;

  for (const key of Object.keys(nextRec)) {
    if (nextRec[key] !== baseRec[key]) {
      result[key] = nextRec[key];
    }
  }
  return result as S;
};

// ---------------------------------------------------------------------------
// Merge helper
// ---------------------------------------------------------------------------
