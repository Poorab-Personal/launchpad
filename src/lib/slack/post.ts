/**
 * Slack incoming-webhook transport.
 *
 * Single env var, single channel. No-ops silently when SLACK_WEBHOOK_URL is
 * unset (Slack alerts are operational sugar — never block the calling code).
 * Errors logged, never thrown.
 */

export interface SlackBlock {
  type: string;
  // Slack Block Kit is structurally varied; we only use a handful of shapes
  // and rely on hand-built blocks at the call site rather than a typed builder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface SlackMessage {
  /** Plaintext fallback shown in notifications + clients that can't render blocks. */
  text: string;
  blocks?: SlackBlock[];
}

export async function postSlackMessage(payload: SlackMessage): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[slack post] SLACK_WEBHOOK_URL not set; skipping');
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      console.error(`[slack post] webhook returned ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[slack post] fetch failed', err);
  }
}
