const mongoose = require("mongoose");
const env = require("./env");

/**
 * ONE connection, reused.
 *
 * The promise is cached on globalThis rather than in a module variable because
 * a serverless platform can re-evaluate this module while keeping the process
 * alive; a plain local would then open a second connection per re-evaluation
 * and exhaust the Atlas connection limit. Caching the PROMISE (not the result)
 * also means concurrent requests during a cold start all await the same
 * connect instead of racing several.
 *
 * WHY THIS IS CALLED FROM app.ts AND NOT ONLY server.ts: Vercel never runs
 * server.ts. It imports the Express app and invokes it per request, so the
 * connectDB() call in server.ts never executed and every query sat buffering
 * until it timed out — "Operation `users.findOne()` buffering timed out",
 * which surfaced to users as "We couldn't verify your Google account".
 */
const cache = globalThis.__mongooseConnection__ || { promise: null };
globalThis.__mongooseConnection__ = cache;

const connectDB = async () => {
    // 1 = connected, 2 = connecting. Either way there is nothing to do.
    if (mongoose.connection.readyState === 1) return mongoose.connection;

    if (!cache.promise) {
        if (!env.mongo_url) {
            throw new Error("MONGO_URI is not set");
        }

        cache.promise = mongoose
            .connect(env.mongo_url, {
                // Fail in a few seconds rather than hanging a request for 30.
                serverSelectionTimeoutMS: 8000,
            })
            .then((m) => {
                console.log("✅ MongoDB Connected");
                return m;
            })
            .catch((error) => {
                // Clear the cache so the NEXT request retries instead of
                // reusing a permanently rejected promise.
                cache.promise = null;
                throw error;
            });
    }

    return cache.promise;
};

module.exports = connectDB;
