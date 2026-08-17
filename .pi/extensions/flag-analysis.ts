/**
 * .pi/extensions/flag-analysis.ts
 *
 * Project-local pi extension that registers the `analyze_feature_flag` tool.
 *
 * When the agent is asked whether a feature flag has dependencies, conflicts,
 * or related work, it can call this tool to run the full analysis DAG defined
 * in `shared/graph.ts` and get back a structured summary — without any
 * network calls (backed by `data/jira.jsonl` and `data/git.json`).
 *
 * Placement: `.pi/extensions/` — picked up automatically by
 * `DefaultResourceLoader` via the `agentDir` option set in
 * `server/routes/chatWithAgent.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { makeFeatureFlagGraph } from "../../shared/graph/flag-analysis.js";
import { runGraph } from "../../server/runAgentFlow.js";

export default function flagAnalysisExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "analyze_feature_flag",
    label: "Analyse Feature Flag",
    description:
      "Runs the feature-flag analysis DAG for the given flag. " +
      "Checks Jira tickets (dependencies, blockers) and the repository " +
      "(merge-conflict risk, confidence score) in parallel, then summarises " +
      "the findings. If issues are found, a fallback remediation is attempted " +
      "which can either resolve the issues (success) or escalate (failure). " +
      "Call this whenever the user asks about dependencies, conflicts, or " +
      "whether a flag is safe to turn on.",
    promptSnippet:
      "analyze_feature_flag(flagName) → jira + repo analysis with a success/failure verdict",
    parameters: Type.Object({
      flagName: Type.String({
        description:
          "The feature flag name to analyse (e.g. 'billing-v3', 'dark-mode'). " +
          "Use the exact flag name or a close keyword.",
      }),
    }),

    execute: async (_toolCallId, params) => {
      let outcome: "success" | "failure" = "success";
      let content = "";

      await Effect.runPromise(
        runGraph(
          makeFeatureFlagGraph(params.flagName, {
            onSuccess: (_state, summary) =>
              Effect.sync(() => {
                outcome = "success";
                content = summary.content;
              }),
            onFailure: (_state, fallbackResult) =>
              Effect.sync(() => {
                outcome = "failure";
                content = fallbackResult.content;
              }),
          }),
        ),
      );

      const verdict =
        outcome === "success"
          ? "✅ **Safe to enable.** No blocking dependencies or high-risk conflicts detected."
          : "🚫 **Enabling blocked.** Automated remediation failed — manual intervention is required before this flag can be enabled.";

      return {
        content: [
          {
            type: "text" as const,
            text: `${verdict}\n\n${content}`,
          },
        ],
        details: { outcome, rawContent: content },
      };
    },
  });
}
