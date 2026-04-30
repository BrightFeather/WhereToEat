import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from './_lib/db';
import { logger, withRequestLogging } from './_lib/logger';
import { ok, err } from './_lib/types';
import { withUser } from './_lib/withUser';

// Recipient is env-driven so we can flip between the Resend sandbox path
// (which only allows sending to the account owner's email) and the
// production path (any address, after verifying a domain on Resend) without
// a code change.
const FEEDBACK_TO = process.env.FEEDBACK_TO || 'prompt.and.ship@gmail.com';
const RESEND_FROM = process.env.FEEDBACK_FROM || 'WhereToEat <onboarding@resend.dev>';
const MAX_MESSAGE_LEN = 5000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5_000_000;          // 5 MB per file (post-base64 decode)
const MAX_TOTAL_ATTACHMENT_BYTES = 15_000_000;   // 15 MB combined — Resend's hard cap is ~40 MB

interface FeedbackAttachment {
  filename?: string;
  contentType?: string;
  base64?: string;
}

interface FeedbackBody {
  message?: string;
  email?: string;     // user-supplied reply-to (overrides users.email)
  appVersion?: string;
  deviceModel?: string;
  iosVersion?: string;
  attachments?: FeedbackAttachment[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.error('feedback.no_api_key', new Error('RESEND_API_KEY missing'));
    return res.status(500).json(err('Email not configured', 'NO_API_KEY'));
  }

  const body = (req.body ?? {}) as FeedbackBody;
  const message = (body.message ?? '').trim();
  if (!message) {
    return res.status(400).json(err('Message is required', 'MISSING_MESSAGE'));
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json(err(`Message exceeds ${MAX_MESSAGE_LEN} chars`, 'MESSAGE_TOO_LONG'));
  }

  // Pull users.email as the default reply-to. Body.email (if user typed
  // something different in the form) wins.
  const [userRow] = (await sql`
    SELECT email, display_name AS "displayName" FROM users WHERE id = ${userId}
  `) as Array<{ email: string | null; displayName: string | null }>;

  const replyTo = (body.email ?? '').trim() || userRow?.email || null;
  const displayName = userRow?.displayName ?? null;

  const subject = `WhereToEat feedback${displayName ? ` from ${displayName}` : ''}`;
  const meta = [
    `User id: ${userId}`,
    displayName ? `Name: ${displayName}` : null,
    replyTo ? `Reply-to: ${replyTo}` : `Reply-to: <none>`,
    body.appVersion ? `App version: ${body.appVersion}` : null,
    body.deviceModel ? `Device: ${body.deviceModel}` : null,
    body.iosVersion ? `iOS: ${body.iosVersion}` : null,
  ].filter(Boolean) as string[];

  // Validate + decode attachments before composing the email. Bad input
  // returns 400 so the iOS toast can show something specific; good input
  // produces the Resend-shaped `attachments: [{filename, content}]` array.
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return res.status(400).json(err(`Up to ${MAX_ATTACHMENTS} photos`, 'TOO_MANY_ATTACHMENTS'));
  }
  let totalBytes = 0;
  const resendAttachments: Array<{ filename: string; content: string; content_type?: string }> = [];
  for (const [i, a] of rawAttachments.entries()) {
    const b64 = (a?.base64 ?? '').replace(/^data:[^,]+,/, '');
    if (!b64) {
      return res.status(400).json(err(`Attachment ${i + 1} is empty`, 'EMPTY_ATTACHMENT'));
    }
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json(err(`Photo ${i + 1} exceeds 5 MB`, 'ATTACHMENT_TOO_LARGE'));
    }
    totalBytes += approxBytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return res.status(400).json(err(`Photos exceed 15 MB combined`, 'ATTACHMENTS_TOO_LARGE'));
    }
    const filename = (a?.filename ?? `photo-${i + 1}.jpg`).slice(0, 80);
    resendAttachments.push({
      filename,
      content: b64,
      content_type: a?.contentType ?? 'image/jpeg',
    });
  }
  const photoMeta = resendAttachments.length > 0
    ? `Photos: ${resendAttachments.length} attached`
    : null;
  if (photoMeta) meta.push(photoMeta);

  const text = `${meta.join('\n')}\n\n---\n\n${message}\n`;
  const html = `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;">${
    escapeHtml(meta.join('\n'))
  }\n\n---\n\n${escapeHtml(message)}</pre>`;

  logger.request('POST', '/api/feedback', {
    userId,
    hasReplyTo: !!replyTo,
    len: message.length,
    attachments: resendAttachments.length,
  });

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [FEEDBACK_TO],
        reply_to: replyTo ?? undefined,
        subject,
        text,
        html,
        attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      logger.error('feedback.resend_failed', new Error(detail), { status: resp.status });
      // Try to surface Resend's structured `{name, message, statusCode}`
      // body so the iOS toast shows something actionable instead of a
      // generic "Could not send feedback". Falls back to the raw text.
      let userMessage = `Resend ${resp.status}`;
      try {
        const parsed = JSON.parse(detail) as { message?: string; name?: string };
        if (parsed.message) userMessage = parsed.message;
        else if (parsed.name) userMessage = parsed.name;
      } catch {
        if (detail) userMessage = detail.slice(0, 300);
      }
      return res.status(502).json(err(userMessage, 'RESEND_ERROR'));
    }

    const json = (await resp.json()) as { id?: string };
    logger.success('feedback.sent', { userId, resendId: json.id });
    return res.status(200).json(ok({ sent: true }));
  } catch (e) {
    logger.error('feedback.exception', e, { userId });
    return res.status(500).json(err('Could not send feedback', 'SEND_FAILED'));
  }
}

export default withRequestLogging(withUser(handler));
