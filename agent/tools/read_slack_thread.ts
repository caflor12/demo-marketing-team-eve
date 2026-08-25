import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Vercel Connect connector UID for the Slack app, resolved to credentials.
 *
 * @remarks
 * Shares the connector the Slack channel uses (`agent/channels/slack.ts`), reached the same way
 * `send_for_review` reaches it: `callSlackApi` is eve's documented escape hatch for calling the
 * Slack Web API from outside an inbound handler. `threadContext` on the channel already reads the
 * thread a message arrives in; this tool is for a thread someone links to instead, which the model
 * has no other way to reach.
 *
 * @defaultValue `"slack/marketing-team"`. Override with the `SLACK_CONNECTOR` environment
 * variable when your connector uses a different name.
 */
const { botToken } = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/marketing-team"
);

/** Matches a Slack message permalink's channel id and packed timestamp. */
const SLACK_PERMALINK_PATTERN = /\/archives\/([A-Z0-9]+)\/p(\d{16})/;

/**
 * Parses a Slack message permalink into the channel id and timestamp
 * `conversations.replies` expects.
 *
 * @remarks
 * Slack permalinks encode the timestamp as `p1234567890123456`, a
 * microsecond-precision integer with the decimal point removed. The last
 * six digits are the fractional seconds.
 */
function parseSlackPermalink(
  link: string
): { channel: string; ts: string } | undefined {
  const match = link.match(SLACK_PERMALINK_PATTERN);
  if (!match) {
    return;
  }
  const [, channel, raw] = match;
  return { channel, ts: `${raw.slice(0, -6)}.${raw.slice(-6)}` };
}

/** Resolves the tool's input down to a channel/ts pair, or undefined. */
function resolveTarget(
  link: string | undefined,
  channel: string | undefined,
  ts: string | undefined
): { channel: string; ts: string } | undefined {
  if (link) {
    return parseSlackPermalink(link);
  }
  if (channel && ts) {
    return { channel, ts };
  }
}

export default defineTool({
  description:
    "Read the messages in a Slack thread someone links to or names, rather than the thread the " +
    "current conversation is already in (that context loads automatically). Use when a brief " +
    "points at a Slack conversation as the source of context instead of pasting it. Accepts a " +
    "Slack message permalink, or a channel ID plus a message timestamp.",
  async execute({ channel, link, ts }) {
    const target = resolveTarget(link, channel, ts);
    if (!target) {
      throw new Error(
        "Could not resolve a thread to read. Provide a valid Slack message permalink, or both a channel ID and a message timestamp."
      );
    }
    const response = await callSlackApi({
      body: { channel: target.channel, ts: target.ts },
      botToken,
      operation: "conversations.replies",
    });
    if (!response.ok) {
      throw new Error(`Slack read failed: ${String(response.error)}`);
    }
    const raw = Array.isArray(response.messages) ? response.messages : [];
    const messages = raw.map((message) => {
      const m = message as { text?: unknown; user?: unknown };
      return {
        text: typeof m.text === "string" ? m.text : "",
        user: typeof m.user === "string" ? m.user : "unknown",
      };
    });
    return { messageCount: messages.length, messages };
  },
  inputSchema: z.object({
    channel: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Slack channel ID (e.g. C0123456789), when not using a permalink. Provide together with ts."
      ),
    link: z
      .string()
      .url()
      .optional()
      .describe(
        "A Slack message or thread permalink, e.g. https://workspace.slack.com/archives/C0123456789/p1234567890123456. Preferred over channel/ts when the user pastes a link."
      ),
    ts: z
      .string()
      .min(1)
      .max(30)
      .optional()
      .describe(
        "Message timestamp (e.g. 1234567890.123456), when not using a permalink. Provide together with channel."
      ),
  }),
  outputSchema: z.object({
    messageCount: z.number().describe("Number of messages returned."),
    messages: z.array(
      z.object({
        text: z.string().describe("The message's text."),
        user: z.string().describe("The Slack user ID who sent it."),
      })
    ),
  }),
});
