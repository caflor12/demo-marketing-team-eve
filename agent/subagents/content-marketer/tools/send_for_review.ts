import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Vercel Connect connector UID for the Slack app, resolved to credentials.
 *
 * @remarks
 * Shares the connector the root Slack channel uses (`agent/channels/slack.ts`), so this tool
 * posts as the same bot install rather than needing a second Slack app or a Slack connection of
 * its own. `callSlackApi` is eve's documented escape hatch for calling the Slack Web API from
 * outside an inbound handler, which is what a subagent tool runs in. The token is resolved fresh
 * from Vercel Connect on each call, so rotation is handled server-side.
 *
 * @defaultValue `"slack/marketing-team"`. Override with the `SLACK_CONNECTOR` environment
 * variable when your connector uses a different name.
 */
const { botToken } = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/marketing-team"
);

/**
 * Slack channel a draft goes to when the caller doesn't name one.
 *
 * @remarks
 * Lets a deployment pin a standing review channel (e.g. `#content-review`) so the model isn't
 * asking for it on every draft. Unset by default: with no channel named either way, the tool
 * fails rather than guessing where to post.
 */
const DEFAULT_REVIEW_CHANNEL = process.env.SLACK_REVIEW_CHANNEL;

/**
 * Posts a finished draft to Slack for human review.
 *
 * @remarks
 * This is a notification, not an approval gate: it doesn't pause the turn or wait for a
 * decision, the way a gated Notion or Resend call would. Reviewing prose isn't a yes/no a tool
 * call can block on, so the review happens in Slack and Notion on the reviewer's own time, and
 * the model moves on once the message is posted. Ungated for the same reason
 * `notion-create-pages` is: posting a review request is the normal, expected end of this
 * workflow, not a side effect to gate.
 */
export default defineTool({
  description:
    "Post a finished draft to Slack for human review: the Notion link plus a short reviewer " +
    "note on what the piece is, its call to action, and how it holds up against brand context. " +
    "Use this after the piece is written into Notion and checked, not instead of finishing it " +
    "there. Name the Slack channel when the user has said where reviews go; otherwise ask them " +
    "rather than guessing, unless the deployment has a standing review channel configured.",
  async execute({ channel, notionUrl, summary, title }) {
    const target = channel ?? DEFAULT_REVIEW_CHANNEL;
    if (!target) {
      throw new Error(
        "No Slack channel to post the review request to. Ask the user which channel reviews go in."
      );
    }
    const response = await callSlackApi({
      body: {
        channel: target,
        text: `*${title}* is ready for review\n${summary}\n<${notionUrl}|Open the draft in Notion>`,
      },
      botToken,
      operation: "chat.postMessage",
    });
    if (!response.ok) {
      throw new Error(`Slack post failed: ${String(response.error)}`);
    }
    return { channel: target, posted: true };
  },
  inputSchema: z.object({
    channel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Slack channel ID or name (e.g. "#content-review") to post the review request in. ' +
          "Omit only when the deployment has a standing review channel configured; otherwise " +
          "ask the user rather than guessing."
      ),
    notionUrl: z
      .string()
      .url()
      .describe("Link to the Notion page holding the finished draft."),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "What a reviewer needs before opening the page: what the piece is, its call to " +
          "action, how it holds up against brand context, and any caveats to check. Not the " +
          "piece itself."
      ),
    title: z
      .string()
      .min(1)
      .max(300)
      .describe("The piece's title, as it appears on the Notion page."),
  }),
  outputSchema: z.object({
    channel: z
      .string()
      .describe("The channel the review request was posted to."),
    posted: z.boolean().describe("True when Slack accepted the message."),
  }),
});
