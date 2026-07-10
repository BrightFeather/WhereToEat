export interface ParsedFeedback {
  userId: string | null;
  name: string | null;
  replyTo: string | null;
  appVersion: string | null;
  device: string | null;
  iosVersion: string | null;
  feedback: string;
}

const HEADER_KEYS: Record<string, keyof ParsedFeedback> = {
  'user id': 'userId',
  name: 'name',
  'reply-to': 'replyTo',
  'app version': 'appVersion',
  device: 'device',
  ios: 'iosVersion',
};

// Parse the Resend feedback email body into structured fields.
// Format from the user's sample:
//   User id: D5E5FCCF-...
//   Name: emily li
//   Reply-to: ...@privaterelay.appleid.com
//   App version: 1.1
//   Device: iPhone
//   iOS: 26.3.1
//   ---
//   <free-form feedback>
export function parseFeedbackBody(body: string): ParsedFeedback {
  const out: ParsedFeedback = {
    userId: null,
    name: null,
    replyTo: null,
    appVersion: null,
    device: null,
    iosVersion: null,
    feedback: '',
  };

  const normalized = body.replace(/\r\n/g, '\n');
  const sepIdx = normalized.indexOf('\n---\n');
  const headerBlock =
    sepIdx >= 0 ? normalized.slice(0, sepIdx) : normalized;
  const feedbackBlock =
    sepIdx >= 0 ? normalized.slice(sepIdx + 5) : '';

  for (const line of headerBlock.split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    const field = HEADER_KEYS[key];
    if (field && !out[field]) {
      (out as unknown as Record<string, string | null>)[field] = value || null;
    }
  }

  out.feedback = feedbackBlock.trim();
  return out;
}
