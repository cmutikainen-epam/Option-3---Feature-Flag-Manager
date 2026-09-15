/**
 * .pi/extensions/stakeholder-alert.ts
 *
 * Pi extension that registers the stakeholder-alert tool.
 *
 * Users can ask the agent: "Alert stakeholders for the billing-v3 flag"
 * and the agent will run the full stakeholder checking and alerting flow.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";

// Import the flow and runtime
import { makeStakeholderAlertGraph } from "../../shared/graph/stakeholder-alert.js";
import { runGraph } from "../../server/runAgentFlow.js";

export default function stakeholderAlertExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "alert_stakeholders",
    label: "Alert Stakeholders",
    description:
      "Check stakeholders for a feature flag and send appropriate alerts. " +
      "If stakeholders exist, they are alerted directly. " +
      "If no stakeholders exist, a fallback alerting channel is used.",
    promptSnippet:
      "alert_stakeholders(flagName) → check stakeholders and send alerts",
    parameters: Type.Object({
      flagName: Type.String({
        description:
          "The feature flag name to check stakeholders for (e.g., 'billing-v3', 'dark-mode'). " +
          "Use the exact flag name or a close keyword.",
      }),
    }),

    execute: async (_toolCallId, params) => {
      let outcome: "success" | "failure" = "success";
      let channel: string = "unknown";
      let recipients: string[] = [];
      let message: string = "";

      await Effect.runPromise(
        runGraph(
          makeStakeholderAlertGraph(params.flagName, {
            onComplete: (state) =>
              Effect.sync(() => {
                if (state.alertResult) {
                  channel = state.alertResult.channel;
                  recipients = Array.from(state.alertResult.recipients);
                  message = state.alertResult.message;
                  outcome = "success";
                }
              }),
          }),
        ),
      );

      const channelLabel =
        channel === "direct"
          ? `✅ **Direct notification** to ${recipients.length} stakeholder(s)`
          : `⚠️ **Fallback channel** (no direct stakeholders found)`;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${channelLabel}\n\n` +
              `Flag: ${params.flagName}\n` +
              `Recipients: ${recipients.join(", ") || "default-alert-channel"}\n` +
              `Message: ${message}`,
          },
        ],
        details: {
          outcome,
          channel,
          recipients,
          flagName: params.flagName,
        },
      };
    },
  });
}
