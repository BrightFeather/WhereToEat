import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';
import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { paths, config } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.send',
];

interface OAuthClientFile {
  installed?: { client_id: string; client_secret: string; redirect_uris?: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris?: string[] };
}

interface SavedToken {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string;
}

function loadOAuthClient(): OAuth2Client {
  if (!fs.existsSync(paths.oauthClient)) {
    throw new Error(
      `Missing ${paths.oauthClient}. Download a Desktop OAuth client from GCP and save it there.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(paths.oauthClient, 'utf8')) as OAuthClientFile;
  const creds = raw.installed ?? raw.web;
  if (!creds) throw new Error('OAuth client file has neither "installed" nor "web" key');
  return new OAuth2Client({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri: 'http://127.0.0.1:0/oauth2callback',
  });
}

export async function getAuthedClient(): Promise<OAuth2Client> {
  const client = loadOAuthClient();
  if (!fs.existsSync(paths.oauthToken)) {
    throw new Error(
      `Missing ${paths.oauthToken}. Run \`npm run gmail:auth\` to do the one-time OAuth dance.`,
    );
  }
  const tok = JSON.parse(fs.readFileSync(paths.oauthToken, 'utf8')) as SavedToken;
  client.setCredentials(tok);
  return client;
}

// Interactive OAuth dance for first-time setup. Spins up a localhost server,
// opens a browser for consent, captures the code, exchanges it for a refresh
// token, writes it to gmail-token.json. Idempotent: deletes any existing token
// first so the user re-grants the latest scope set.
export async function runInteractiveAuth(): Promise<void> {
  const baseClient = loadOAuthClient();

  // Bind to a random port so we don't fight whatever else might be on 8080.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine OAuth callback port');
  }
  const port = address.port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const client = new OAuth2Client({
    clientId: (baseClient as unknown as { _clientId: string })._clientId,
    clientSecret: (baseClient as unknown as { _clientSecret: string })._clientSecret,
    redirectUri,
  });

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\nOpen this URL in a browser to authorize:\n');
  console.log(authUrl);
  console.log('\nWaiting for the redirect...\n');

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const c = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400).end(`OAuth error: ${err}`);
          reject(new Error(err));
          return;
        }
        if (!c) {
          res.writeHead(400).end('Missing ?code');
          reject(new Error('Missing OAuth code'));
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<h1>Authorized.</h1><p>You can close this tab.</p>');
        resolve(c);
      } catch (e) {
        reject(e as Error);
      }
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token returned. Revoke the app at https://myaccount.google.com/permissions and retry.',
    );
  }
  fs.writeFileSync(paths.oauthToken, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(paths.oauthToken, 0o600);
  console.log(`Wrote ${paths.oauthToken}`);
}

export async function gmail(): Promise<gmail_v1.Gmail> {
  const auth = await getAuthedClient();
  return google.gmail({ version: 'v1', auth });
}

export interface FeedbackEmail {
  threadId: string;
  messageId: string;
  internalDate: number;
  from: string;
  subject: string;
  body: string;
}

export async function listUnprocessedFeedback(maxResults = 50): Promise<FeedbackEmail[]> {
  const g = await gmail();
  const labelId = await ensureProcessedLabel(g);
  const query = `from:${config.feedbackSender} -label:${config.processedLabelName}`;
  const list = await g.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });
  const messages = list.data.messages ?? [];
  const out: FeedbackEmail[] = [];
  for (const m of messages) {
    if (!m.id || !m.threadId) continue;
    const full = await g.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'full',
    });
    const headers = full.data.payload?.headers ?? [];
    const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
    const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
    const body = extractBody(full.data);
    out.push({
      threadId: m.threadId,
      messageId: m.id,
      internalDate: Number(full.data.internalDate ?? 0),
      from,
      subject,
      body,
    });
  }
  // Stable order: oldest first so today's processing follows arrival order.
  out.sort((a, b) => a.internalDate - b.internalDate);
  // Just to keep the labelId in scope without unused-var warnings.
  void labelId;
  return out;
}

function extractBody(msg: gmail_v1.Schema$Message): string {
  const decode = (data: string | undefined | null): string => {
    if (!data) return '';
    return Buffer.from(data, 'base64url').toString('utf8');
  };
  const walk = (
    part: gmail_v1.Schema$MessagePart | undefined,
  ): { plain: string; html: string } => {
    if (!part) return { plain: '', html: '' };
    let plain = '';
    let html = '';
    if (part.mimeType === 'text/plain') {
      plain += decode(part.body?.data);
    } else if (part.mimeType === 'text/html') {
      html += decode(part.body?.data);
    }
    for (const child of part.parts ?? []) {
      const sub = walk(child);
      plain += sub.plain;
      html += sub.html;
    }
    return { plain, html };
  };
  const root = msg.payload;
  const { plain, html } = walk(root);
  if (plain.trim().length > 0) return plain;
  if (html.trim().length > 0) return htmlToText(html);
  return '';
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function ensureProcessedLabel(g: gmail_v1.Gmail): Promise<string> {
  const list = await g.users.labels.list({ userId: 'me' });
  const existing = list.data.labels?.find(
    (l) => l.name === config.processedLabelName,
  );
  if (existing?.id) return existing.id;
  const created = await g.users.labels.create({
    userId: 'me',
    requestBody: {
      name: config.processedLabelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  if (!created.data.id) throw new Error('Failed to create processed label');
  return created.data.id;
}

export async function markThreadProcessed(threadId: string): Promise<void> {
  const g = await gmail();
  const labelId = await ensureProcessedLabel(g);
  await g.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds: [labelId] },
  });
}
