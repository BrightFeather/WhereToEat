import type { VercelRequest, VercelResponse } from '@vercel/node';

type LogLevel = 'info' | 'warn' | 'error';
type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void | VercelResponse>;

function log(level: LogLevel, action: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    action,
    ...data,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  request(method: string, path: string, params?: Record<string, unknown>) {
    log('info', 'request.received', { method, path, ...params });
  },
  success(action: string, data?: Record<string, unknown>) {
    log('info', action, data);
  },
  warn(action: string, data?: Record<string, unknown>) {
    log('warn', action, data);
  },
  error(action: string, error: unknown, data?: Record<string, unknown>) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log('error', action, { error: message, stack, ...data });
  },
};

/**
 * Wraps a handler and logs every incoming request with method, path,
 * query params, body keys, and the IP/user-agent from headers.
 */
export function withRequestLogging(handler: Handler): Handler {
  return async (req: VercelRequest, res: VercelResponse) => {
    const start = Date.now();
    const path = req.url ?? 'unknown';
    const method = req.method ?? 'UNKNOWN';

    log('info', 'http.request', {
      method,
      path,
      query: req.query,
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined,
      ip: req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress,
      ua: req.headers['user-agent'],
    });

    // Intercept res.end to log the response status
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      log('info', 'http.response', {
        method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
      return originalJson(body);
    };

    return handler(req, res);
  };
}
