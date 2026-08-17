/**
 * shared/graph/index.ts
 *
 * Generic agent-graph library. Provides:
 *   • AgentNode<S>, AgentGraph<S>, NodeHandler<S>, etc.
 *   • GraphBuilder<S> for declarative graph construction
 *   • No flow-specific logic
 *
 * To build a concrete flow, import these and create your own graph
 * (like `flag-analysis.ts` does for the feature-flag analysis flow).
 */

import { Effect, Graph } from "effect";

// ---------------------------------------------------------------------------
// Generic graph primitives
// ---------------------------------------------------------------------------

/**
 * The result a node handler produces:
 *   • `state`       — the (possibly updated) shared flow state
 *   • `transitions` — the set of outgoing edge labels to follow next. An empty
 *                     array means "follow every outgoing edge" (the common case
 *                     for linear / fan-out nodes). A non-empty array means the
 *                     node is branching and only edges with a matching label
 *                     are taken.
 */
export interface NodeResult<S> {
  readonly state: S;
  readonly transitions: readonly string[];
}

/**
 * A node handler: given the current shared state, produce the next state and
 * routing decision. Handlers are the *only* place flow-specific logic lives.
 */
export type NodeHandler<S> = (state: S) => Effect.Effect<NodeResult<S>>;

/**
 * Node payload stored in the graph. Every node has a stable `kind` (for
 * logging / lookup), a `handler`, and a `terminal` flag.
 */
export interface AgentNode<S> {
  readonly kind: string;
  readonly handler: NodeHandler<S>;
  readonly terminal: boolean;
}

/**
 * Edge payload: just a routing `label`. A node's `transitions` are matched
 * against these labels.
 */
export interface Transition {
  readonly label: string;
}

/**
 * A fully-described, runnable agent graph over a state type `S`.
 *
 * This is the *only* thing `runGraph` needs. Anyone can construct one of
 * these for an arbitrary flow.
 */
export interface AgentGraph<S> {
  readonly graph: Graph.DirectedGraph<AgentNode<S>, Transition>;
  /** The state the flow starts with. */
  readonly initialState: S;
  /**
   * Called by the runtime whenever a terminal node is reached, with the
   * terminal node's kind and the final state. Optional.
   */
  readonly onTerminal?: (kind: string, state: S) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// A small builder to make constructing graphs pleasant & type-safe
// ---------------------------------------------------------------------------

/**
 * Fluent-ish builder. You declare nodes (each with a handler) and edges (each
 * with a label), then `build(initialState, onTerminal?)`.
 *
 * The builder keeps a name → NodeIndex map so edges can be declared by the
 * human-readable node name rather than raw indices.
 */
export class GraphBuilder<S> {
  private readonly nodeSpecs: Array<{
    name: string;
    handler: NodeHandler<S>;
    terminal: boolean;
  }> = [];
  private readonly edgeSpecs: Array<{
    from: string;
    to: string;
    label: string;
  }> = [];

  /** Declare a processing node. */
  node(name: string, handler: NodeHandler<S>): this {
    this.nodeSpecs.push({ name, handler, terminal: false });
    return this;
  }

  /** Declare a terminal node. Its handler may be a no-op. */
  terminal(
    name: string,
    handler: NodeHandler<S> = (state) => Effect.succeed({ state, transitions: [] }),
  ): this {
    this.nodeSpecs.push({ name, handler, terminal: true });
    return this;
  }

  /**
   * Declare an edge `from -> to`. `label` defaults to `to`, so a branching
   * node can emit the target's name as its transition.
   */
  edge(from: string, to: string, label: string = to): this {
    this.edgeSpecs.push({ from, to, label });
    return this;
  }

  build(
    initialState: S,
    onTerminal?: (kind: string, state: S) => Effect.Effect<void>,
  ): AgentGraph<S> {
    const indexByName = new Map<string, Graph.NodeIndex>();

    const graph = Graph.directed<AgentNode<S>, Transition>((m) => {
      for (const spec of this.nodeSpecs) {
        const idx = Graph.addNode(m, {
          kind: spec.name,
          handler: spec.handler,
          terminal: spec.terminal,
        });
        indexByName.set(spec.name, idx);
      }
      for (const spec of this.edgeSpecs) {
        const from = indexByName.get(spec.from);
        const to = indexByName.get(spec.to);
        if (from === undefined) {
          throw new Error(`GraphBuilder: unknown edge source "${spec.from}"`);
        }
        if (to === undefined) {
          throw new Error(`GraphBuilder: unknown edge target "${spec.to}"`);
        }
        Graph.addEdge(m, from, to, { label: spec.label });
      }
    });

    return { graph, initialState, onTerminal };
  }
}
