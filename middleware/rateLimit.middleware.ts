import { Request, Response, NextFunction } from "express";

/**
 * A minimal in-memory, per-key fixed-window throttle.
 *
 * The repo has no rate-limiting layer (see memory "Gaps: … no rate limiting"),
 * and the public form submit endpoint is the first route where its absence is
 * an actual spam vector rather than a theoretical one. This is deliberately
 * small: a Map of counters swept lazily, no dependency, no Redis.
 *
 * LIMIT: it is per-process, so behind two API nodes each enforces its own
 * window — the same single-process caveat the socket presence registry carries.
 * Good enough to blunt a script; a real abuse story needs a shared store.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Cheap opportunistic GC so the Map cannot grow without bound.
let lastSweep = 0;
const sweep = (now: number) => {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
};

const clientIp = (req: Request) =>
  (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
  req.socket.remoteAddress ||
  "unknown";

/**
 * `memoryRateLimit({ windowMs, max, key? })` — 429s once `max` requests land in
 * the same window. `key` defaults to the client IP scoped by route path so two
 * endpoints do not share a counter.
 */
export function memoryRateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}) {
  const { windowMs, max, key } = opts;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);

    const id = `${req.baseUrl}${req.path}:${key ? key(req) : clientIp(req)}`;
    const bucket = buckets.get(id);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        message: "Too many requests. Please wait a moment and try again.",
      });
    }

    bucket.count += 1;
    next();
  };
}
