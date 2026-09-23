import http from "http";
import dotenv from "dotenv";
import app from "./app";
import connectDB from "./config/db";
import env from "./config/env";
import { syncActivityRetention } from "./models/Activity";
import { attachRealtime } from "./services/realtime.service";
dotenv.config();

// The TTL window lives inside the index, so it has to be reconciled with
// ACTIVITY_RETENTION_DAYS on every boot — see models/Activity.ts.
connectDB()
    .then(() => syncActivityRetention())
    // Not fatal any more: the per-request guard in app.ts retries, so a Mongo
    // blip at boot no longer has to take the whole process down with it.
    .catch((error) => console.error("MongoDB connect failed at boot:", error?.message));

/**
 * Express no longer listens for itself. Socket.IO needs the raw HTTP server so
 * it can take over the upgrade handshake on /socket.io while every /api route
 * carries on being served by the same port — one origin, one token, no second
 * process to run or deploy.
 */
const server = http.createServer(app);

attachRealtime(server);

server.listen(env.port, () => {
    console.log(`Server-> http://localhost:${env.port}`);
    console.log(`Realtime-> ws://localhost:${env.port}/socket.io`);
});
