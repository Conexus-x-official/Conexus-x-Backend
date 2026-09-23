import crypto from "crypto";
import { Types } from "mongoose";
import Pit from "../models/Pit";


export const generateApiKey = (): string => {

    const randomBytes = crypto.randomBytes(32).toString("hex");

    return `crm_${randomBytes}`;

};


/**
 * How long a user must wait after (re)generating their PIT key before they
 * may generate another. Read by generateKey() in apiKey.controller.ts, which
 * is the only path that ever rotates an existing token — creation via
 * ensureApiKey() starts the same clock so a brand-new key cannot be rotated
 * again immediately either.
 */
export const PIT_KEY_COOLDOWN_MS = 20 * 60 * 1000;


export const nextAllowedAt = (lastGeneratedAt: Date): Date =>
    new Date(lastGeneratedAt.getTime() + PIT_KEY_COOLDOWN_MS);


/**
 * Make sure a user has a Pit (API key) doc, without overwriting one that
 * already exists. Called from register/login/Google sign-in, where the
 * intent is "this account has a key" rather than "issue a fresh one" — that
 * is what generateKey() in apiKey.controller.ts is for.
 *
 * Atomic upsert (not exists-then-create): two concurrent sign-ins for the
 * same brand-new user must not race two Pit docs into existence and trip the
 * `user` unique index.
 */
export const ensureApiKey = async (user: {
    _id: Types.ObjectId | string;
    firstName: string;
    lastName?: string;
}): Promise<void> => {

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Unnamed";

    await Pit.findOneAndUpdate(
        { user: user._id },
        { $setOnInsert: { token: generateApiKey(), name, lastGeneratedAt: new Date() } },
        { upsert: true }
    );

};
