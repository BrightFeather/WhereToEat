import fs from 'node:fs';
import { paths, readSecret } from '../config.js';
import { complete } from '../llm.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function run(): Promise<void> {
  const checks: Check[] = [];

  checks.push({
    name: 'DeepSeek key (~/.config/wte-feedback-agent/secrets.env or env)',
    ok: Boolean(readSecret('DEEP_SEEK_API')),
    detail: readSecret('DEEP_SEEK_API') ? 'present' : 'MISSING',
  });

  checks.push({
    name: `Gmail OAuth client (${paths.oauthClient})`,
    ok: fs.existsSync(paths.oauthClient),
    detail: fs.existsSync(paths.oauthClient) ? 'present' : 'MISSING — download Desktop OAuth client',
  });

  checks.push({
    name: `Gmail OAuth token (${paths.oauthToken})`,
    ok: fs.existsSync(paths.oauthToken),
    detail: fs.existsSync(paths.oauthToken)
      ? 'present'
      : 'MISSING — run `npm run gmail:auth` to do the one-time OAuth dance',
  });

  if (readSecret('DEEP_SEEK_API')) {
    try {
      const r = await complete({
        model: 'deepseek-v4-flash',
        maxTokens: 8,
        messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      });
      checks.push({
        name: 'DeepSeek live ping (deepseek-v4-flash)',
        ok: r.content.toLowerCase().includes('ok'),
        detail: `content="${r.content}" tokens=${r.usage.totalTokens}`,
      });
    } catch (e) {
      checks.push({
        name: 'DeepSeek live ping (deepseek-v4-flash)',
        ok: false,
        detail: `ERROR ${(e as Error).message}`,
      });
    }
  }

  let allOk = true;
  for (const c of checks) {
    const tag = c.ok ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${c.name}\n        ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log();
  console.log(allOk ? 'All checks passed.' : 'Some checks failed — see above.');
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
