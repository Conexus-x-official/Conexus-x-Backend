// services/realtime.service.ts

import type { Server as HttpServer } from "http";
import { Server as IOServer, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import env from "../config/env";
import User from "../models/User";
import WorkspaceMember from "../models/WorkspaceMember";
import Conversation from "../models/Conversation";
import { getMembership, resolveModuleAccess } from "./access.service";
import { PRESENCE_TIMEOUT_MS } from "./presence.service";

/**
 * The push layer. Everything the REST API writes, this announces.
 *
 * Why it exists: two people on the same board saw each other's work only when
 * something remounted, because the client's freshness window is 60s and nothing
 * told it otherwise. Shortening that window would have meant every open tab
 * re-fetching every board forever; this replaces the question "has anything
 * changed?" with the server saying so once, to exactly the people looking at it.
 *
 * ONE OUTBOUND EVENT. Every change rides the same `crm:change` envelope rather
 * than a bespoke event name per entity, so the client bridge is one table
 * instead of forty listeners that drift apart. Adding an entity is a row here
 * and a row there.
 */

/* ------------------------------------------------------------------ rooms */

/**
 * Room names are derived, never passed in — a client asks to subscribe to an
 * id and the server decides the room string, so nothing can join a room
 * belonging to a workspace it was never checked against.
 */
export const userRoom = (userId: string) => `user:${userId}`;
export const workspaceRoom = (workspaceId: string) => `ws:${workspaceId}`;
export const moduleRoom = (moduleId: string) => `mod:${moduleId}`;

/**
 * A Conexus Meet thread. Separate from the workspace room because conversation
 * membership is NARROWER than workspace membership — being in the workspace
 * lets you start a thread, never read one you were not added to.
 */
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;

/* ----------------------------------------------------------------- events */

export type ChangeEntity =
    | "record"
    | "recordValue"
    | "collection"
    | "column"
    | "module"
    | "amendment"
    | "workspace"
    | "member"
    | "moduleAccess"
    | "automation"
    | "activity"
    | "presence"
    | "conversation"
    | "message"
    | "typing"
    | "notification";

export type ChangeAction = "created" | "updated" | "deleted" | "moved";

export interface ChangeEvent {
    entity: ChangeEntity;
    action: ChangeAction;

    /** The entity's own id, so a delete can be applied with no payload. */
    id?: string;

    workspaceId?: string;
    moduleId?: string;
    collectionId?: string;
    /** The collection a record came FROM, so a move can patch both lists. */
    fromCollectionId?: string;
    recordId?: string;
    /** Set when the row is a sub-record — its list is keyed by the parent. */
    parentRecordId?: string;
    columnId?: string;
    /** "record" | "subrecord" — which column list a column belongs to. */
    scope?: string;

    /** Conexus Meet: the thread this belongs to. */
    conversationId?: string;

    /** The authoritative document, when the client can patch straight from it. */
    data?: unknown;

    /** Who caused it. The client renders this; it never trusts it for access. */
    actorId?: string;

    at: string;
}

/**
 * WHICH ROOM EACH ENTITY IS ANNOUNCED IN.
 *
 * Board-scoped rows go to the board room alone. A cell edit is the highest
 * frequency event in the product, and sending it to everyone in the workspace
 * would mean a person reading an unrelated board pays for every keystroke on
 * this one.
 *
 * Workspace-scoped rows go to the workspace room, because the lists they change
 * (the module index, the member table, presence dots) are drawn outside any one
 * board.
 */
const SCOPE: Record<ChangeEntity, "module" | "workspace" | "conversation"> = {
    record: "module",
    recordValue: "module",
    collection: "module",
    column: "module",
    amendment: "module",

    module: "workspace",
    workspace: "workspace",
    member: "workspace",
    moduleAccess: "workspace",
    automation: "workspace",
    activity: "workspace",
    presence: "workspace",

    // Meet rides its own thread room; see the routing rules in emitChange.
    conversation: "conversation",
    message: "conversation",
    typing: "conversation",

    // Unreachable in practice: a notification is always sent with an explicit
    // `audience` (one person, not a room — see createNotification), and that
    // path returns before this table is ever consulted. Still required so
    // SCOPE stays a total map over ChangeEntity.
    notification: "workspace"
};

/* ----------------------------------------------------------- the instance */

let io: IOServer | null = null;

/** Null until attachRealtime runs, so every emit site tolerates no io. */
export const getIO = () => io;

/* --------------------------------------------------------------- presence */

/**
 * userId -> the socket ids that user currently has open.
 *
 * A Set, not a boolean: two tabs are ordinary, and closing one must not mark
 * the person offline while the other is still on screen.
 *
 * IN-MEMORY, therefore single-process. Running more than one API node needs
 * @socket.io/redis-adapter here and a shared store for this map; until then a
 * second node would each believe it holds the whole truth.
 */
const connections = new Map<string, Set<string>>();

export const isUserConnected = (userId: string) =>
    (connections.get(userId)?.size ?? 0) > 0;

/**
 * Presence stays derived from `lastSeen` everywhere else in the codebase — the
 * socket just writes it accurately instead of the client beating every 60s.
 * Disconnecting BACKDATES lastSeen past the timeout so the very next read of
 * effectiveStatus() says offline, with no window to wait out.
 */
const markOnline = (userId: string) =>
    User.updateOne({ _id: userId }, { lastSeen: new Date() })
        .catch(() => undefined);

const markOffline = (userId: string) =>
    User.updateOne(
        { _id: userId },
        { lastSeen: new Date(Date.now() - PRESENCE_TIMEOUT_MS - 1000) }
    ).catch(() => undefined);

/**
 * Which workspace rooms should hear about this person. Their dot is drawn in
 * every workspace they belong to, so presence fans out to all of them — and to
 * nobody else, which is what keeps "appear offline" from leaking sideways.
 */
const workspacesOf = async (userId: string): Promise<string[]> => {
    try {
        const rows = await WorkspaceMember.find({
            user: userId,
            status: "active"
        }).select("workspace").lean();

        return rows.map((row: any) => String(row.workspace));
    } catch {
        return [];
    }
};

/**
 * Fan a presence change out to every workspace the person belongs to. Exported
 * because picking a status (busy / dnd / appear offline) still goes through the
 * REST endpoint — connect and disconnect are not the only ways it changes.
 */
export const announcePresence = async (userId: string) => {
    if (!io) return;

    const workspaces = await workspacesOf(userId);
    if (!workspaces.length) return;

    for (const workspaceId of workspaces) {
        io.to(workspaceRoom(workspaceId)).emit("crm:change", {
            entity: "presence",
            action: "updated",
            id: userId,
            actorId: userId,
            workspaceId,
            at: new Date().toISOString()
        } satisfies ChangeEvent);
    }
};

/**
 * lastSeen has to keep moving for the HTTP reads that never see a socket —
 * getWorkspaceMembers derives presence from it on every request. One bulk write
 * a minute for the whole connected set is cheaper than a heartbeat request per
 * user per minute, which is exactly what this replaces.
 */
const PRESENCE_SWEEP_MS = 60 * 1000;
let sweep: NodeJS.Timeout | null = null;

const startPresenceSweep = () => {
    if (sweep) return;

    sweep = setInterval(() => {
        const ids = [...connections.keys()].filter((id) => isUserConnected(id));
        if (!ids.length) return;

        User.updateMany(
            { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
            { lastSeen: new Date() }
        ).catch(() => undefined);
    }, PRESENCE_SWEEP_MS);

    // Never hold the process open for a housekeeping timer.
    sweep.unref?.();
};

/* ------------------------------------------------------------------- emit */

export interface EmitInput extends Omit<ChangeEvent, "at"> {
    /**
     * The socket that caused this, read from the `x-socket-id` request header.
     * That client already applied the change optimistically, so echoing it back
     * would either be a no-op or fight its own pending patch. Excluded at the
     * SERVER rather than filtered at the client, so the bytes are never sent.
     */
    originId?: string;

    /**
     * Deliver to these USERS rather than to a shared room — every device each
     * of them has open.
     *
     * Needed because some changes have no room that already holds the right
     * people. A brand-new conversation is the clearest case: the other person
     * is not in `conv:<id>` yet precisely BECAUSE they have never seen it, so a
     * room broadcast would reach nobody who needed it. Being removed from a
     * team is the mirror image — the person to tell is the one who just lost
     * their place in the room.
     */
    audience?: string[];
}

/**
 * Announce a change. Best-effort by the same rule logActivity follows: a push
 * that fails must never fail the write the user actually asked for.
 */
export const emitChange = (input: EmitInput): void => {
    if (!io) return;

    try {
        const { originId, audience, ...rest } = input;

        const event: ChangeEvent = { ...rest, at: new Date().toISOString() };

        /**
         * An explicit audience WINS over the scope table. It is used where no
         * shared room already holds the right people — see EmitInput.audience.
         * De-duplicated because the same person can legitimately appear twice
         * (a team's member list plus the person just removed from it).
         */
        if (audience?.length) {
            const rooms = [...new Set(audience.map(String))].map(userRoom);

            const channel = originId
                ? io.to(rooms).except(originId)
                : io.to(rooms);

            channel.emit("crm:change", event);
            return;
        }

        const scope = SCOPE[rest.entity];

        const room =
            scope === "module"
                ? rest.moduleId && moduleRoom(String(rest.moduleId))
                : scope === "conversation"
                    ? rest.conversationId && conversationRoom(String(rest.conversationId))
                    : rest.workspaceId && workspaceRoom(String(rest.workspaceId));

        // Without a room this would broadcast to every connected socket.
        if (!room) return;

        const channel = originId ? io.to(room).except(originId) : io.to(room);

        channel.emit("crm:change", event);
    } catch (error) {
        console.error("Realtime emit failed:", (error as Error).message);
    }
};

/** Reads the origin socket id off a request. See EmitInput.originId. */
export const originOf = (req: {
    headers?: Record<string, any>;
}): string | undefined => {
    const raw = req?.headers?.["x-socket-id"];
    const id = Array.isArray(raw) ? raw[0] : raw;
    return typeof id === "string" && id ? id : undefined;
};

/* ----------------------------------------------------------------- server */

interface SocketData {
    userId: string;
}

export const attachRealtime = (server: HttpServer): IOServer => {
    io = new IOServer(server, {
        path: "/socket.io",
        // Mirrors app.ts's open cors(). Tighten both together, not one of them.
        cors: { origin: "*", methods: ["GET", "POST"] }
    });

    /**
     * Auth on the HANDSHAKE, not on the first message. An unauthenticated
     * socket is never allowed to exist, so no handler below has to re-ask.
     */
    io.use((socket, next) => {
        try {
            const fromAuth = (socket.handshake.auth as any)?.token;
            const fromHeader = String(
                socket.handshake.headers?.authorization || ""
            ).split(" ")[1];

            const token = fromAuth || fromHeader;

            if (!token) return next(new Error("No token"));

            // Same secret and same non-null assertion as middleware/auth.middleware.ts —
            // a socket must not authenticate on rules the REST routes do not use.
            const decoded = jwt.verify(token, env.jwt_secret!) as {
                userId?: string;
            };

            if (!decoded?.userId) return next(new Error("Invalid token"));

            (socket.data as SocketData).userId = decoded.userId;

            return next();
        } catch {
            return next(new Error("Invalid token"));
        }
    });

    io.on("connection", (socket: Socket) => {
        const userId = (socket.data as SocketData).userId;

        socket.join(userRoom(userId));

        const first = !isUserConnected(userId);

        if (!connections.has(userId)) connections.set(userId, new Set());
        connections.get(userId)!.add(socket.id);

        if (first) {
            void markOnline(userId).then(() => announcePresence(userId));
        }

        /**
         * Subscribing is a REQUEST, always re-checked here. The client asks for
         * an id; access.service decides. This is the same gate the REST routes
         * use, so a board you cannot GET is a board you cannot listen to.
         */
        socket.on("subscribe", async (payload: any, ack?: (r: any) => void) => {
            const joined: string[] = [];

            try {
                const workspaceId = payload?.workspaceId
                    ? String(payload.workspaceId)
                    : "";

                if (workspaceId) {
                    const membership = await getMembership(workspaceId, userId);
                    if (membership) {
                        socket.join(workspaceRoom(workspaceId));
                        joined.push(workspaceRoom(workspaceId));
                    }
                }

                const moduleId = payload?.moduleId ? String(payload.moduleId) : "";

                if (moduleId) {
                    const access = await resolveModuleAccess(userId, moduleId);
                    if (access.allowed) {
                        socket.join(moduleRoom(moduleId));
                        joined.push(moduleRoom(moduleId));
                    }
                }

                /**
                 * Conversation membership, NOT workspace membership. Being in
                 * the workspace is what lets you start a thread; it is not what
                 * lets you read one, so this asks the conversation itself.
                 */
                const conversationId = payload?.conversationId
                    ? String(payload.conversationId)
                    : "";

                if (conversationId && mongoose.isValidObjectId(conversationId)) {
                    const inThread = await Conversation.exists({
                        _id: conversationId,
                        "members.user": userId
                    });

                    if (inThread) {
                        socket.join(conversationRoom(conversationId));
                        joined.push(conversationRoom(conversationId));
                    }
                }
            } catch (error) {
                console.error("Subscribe failed:", (error as Error).message);
            }

            ack?.({ joined });
        });

        /**
         * TYPING — the one event that is never persisted.
         *
         * It is worthless a second after it is sent and writing it would mean a
         * database round trip per keystroke, so it is relayed straight to the
         * room and forgotten. Re-checked against the socket's rooms rather than
         * trusted: a client could otherwise post "X is typing" into any thread
         * by naming its id.
         */
        socket.on("meet:typing", (payload: any) => {
            const conversationId = String(payload?.conversationId ?? "");
            if (!conversationId) return;

            const room = conversationRoom(conversationId);
            if (!socket.rooms.has(room)) return;

            socket.to(room).emit("crm:change", {
                entity: "typing",
                action: "updated",
                id: userId,
                conversationId,
                actorId: userId,
                data: { typing: payload?.typing !== false },
                at: new Date().toISOString()
            } satisfies ChangeEvent);
        });

        /**
         * WEBRTC SIGNALLING — offers, answers and ICE candidates.
         *
         * The server is a RELAY and nothing more: it never parses SDP, never
         * holds call state, and never touches media. Audio and video go peer to
         * peer, which is what makes calls cost nothing to run; this socket only
         * carries the few hundred bytes of negotiation that let two browsers
         * find each other.
         *
         * Every frame is addressed to ONE user and re-checked here, so a client
         * cannot inject a candidate into a call it is not part of. `from` is
         * stamped server-side from the handshake — a caller-supplied identity
         * would let anyone impersonate anyone in a ring.
         */
        socket.on("meet:signal", async (payload: any) => {
            try {
                const to = String(payload?.to ?? "");
                const conversationId = String(payload?.conversationId ?? "");

                if (!to || !conversationId) return;
                if (!mongoose.isValidObjectId(conversationId)) return;

                // Both ends must be in the thread the call belongs to.
                const allowed = await Conversation.exists({
                    _id: conversationId,
                    "members.user": { $all: [userId, to] }
                });

                if (!allowed) return;

                io?.to(userRoom(to)).emit("meet:signal", {
                    kind: String(payload?.kind ?? ""),
                    conversationId,
                    from: userId,
                    payload: payload?.payload ?? null,
                    at: new Date().toISOString()
                });
            } catch (error) {
                console.error("Signal relay failed:", (error as Error).message);
            }
        });

        socket.on("unsubscribe", (payload: any) => {
            if (payload?.workspaceId) {
                socket.leave(workspaceRoom(String(payload.workspaceId)));
            }
            if (payload?.moduleId) {
                socket.leave(moduleRoom(String(payload.moduleId)));
            }
        });

        socket.on("disconnect", () => {
            const set = connections.get(userId);
            if (!set) return;

            set.delete(socket.id);

            if (set.size === 0) {
                connections.delete(userId);
                void markOffline(userId).then(() => announcePresence(userId));
            }
        });
    });

    startPresenceSweep();

    return io;
};
