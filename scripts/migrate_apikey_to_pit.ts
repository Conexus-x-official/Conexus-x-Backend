/**
 * One-time migration: copy every User.apiKey into the new Pit collection.
 *
 * apiKey.controller.ts and auth.middleware.ts now read/write Pit exclusively
 * and the `apiKey` field was dropped from models/User.ts, so this is the only
 * way an already-issued key survives the change instead of 401ing the next
 * time an integrator uses it. Reads the old field through the native driver
 * (raw collection, not the Mongoose model) since it no longer exists in the
 * schema. Idempotent: skips a user that already has a Pit doc.
 *
 *   npx ts-node scripts/migrate_apikey_to_pit.ts [--dry]
 */

import mongoose from "mongoose";
const env = require("../config/env");
import Pit from "../models/Pit";

async function main() {
    const dry = process.argv.includes("--dry");

    await mongoose.connect(String(env.mongo_url));

    const users = await mongoose.connection
        .collection("users")
        .find({ apiKey: { $exists: true, $ne: null } })
        .project({ apiKey: 1, firstName: 1, lastName: 1 })
        .toArray();

    console.log(`Found ${users.length} user(s) with a legacy apiKey.`);

    let migrated = 0;
    let skipped = 0;

    for (const user of users) {
        const existing = await Pit.findOne({ user: user._id });

        if (existing) {
            skipped++;
            continue;
        }

        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

        console.log(`  ${dry ? "[dry] would create" : "creating"} Pit for ${user._id} (${name || "unnamed"})`);

        if (!dry) {
            await Pit.create({
                user: user._id,
                name: name || "Unnamed",
                token: user.apiKey,
            });
        }

        migrated++;
    }

    console.log(`${dry ? "Would migrate" : "Migrated"} ${migrated}, skipped ${skipped} (already had a Pit).`);

    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error("Failed:", error?.message ?? error);
    await mongoose.disconnect();
    process.exit(1);
});
