import mongoose, { Document, Model, Schema } from "mongoose";
import env from "../config/env";

/**
 * The audit trail: who changed what, where, when, and from which value to which.
 *
 * Retention is env.activity_retention_days (ACTIVITY_RETENTION_DAYS). Mongo bakes
 * a TTL index's window in at creation time, so syncActivityRetention() below
 * rebuilds the index when that number changes — see server.ts.
 */

export const ACTIVITY_ACTIONS = [
  "workspace_created",
  "workspace_updated",
  "workspace_deleted",
  "member_invited",
  "member_joined",
  "member_invite_declined",
  "member_removed",
  "member_role_changed",
  "module_access_changed",
  "module_created",
  "module_updated",
  "module_deleted",
  "collection_created",
  "collection_updated",
  "collection_deleted",
  "record_created",
  "record_updated",
  "record_moved",
  "record_deleted",
  "column_created",
  "column_updated",
  "column_deleted",
  "cell_updated",
  "comment_added",
  "comment_deleted",
  "file_uploaded",
  "file_deleted",
  "login"
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface IActivity extends Document {
  workspace: mongoose.Types.ObjectId;
  module?: mongoose.Types.ObjectId;
  collectionName?: mongoose.Types.ObjectId;
  record?: mongoose.Types.ObjectId;
  column?: mongoose.Types.ObjectId;

  /** Who did it. */
  user: mongoose.Types.ObjectId;

  action: ActivityAction;

  /** Human-readable one-liner for the feed. */
  message: string;

  /** What the thing was called at the time — survives the target being deleted. */
  targetName?: string;

  /** The "from → to" pair. Mixed because a cell value can be any shape. */
  before?: unknown;
  after?: unknown;

  metadata?: Record<string, unknown>;

  /** Set once this entry has been rolled back — a row reverts at most once. */
  revertedAt?: Date;
  revertedBy?: mongoose.Types.ObjectId;
  /** On a revert entry, points back at the row it undid. */
  revertOf?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const ActivitySchema = new Schema<IActivity>(
  {
    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    module: {
      type: Schema.Types.ObjectId,
      ref: "Module",
    },

    // Named `collectionName`, not `collection`: Document.collection is the
    // Mongoose driver handle. Record and RecordValue use the same name.
    collectionName: {
      type: Schema.Types.ObjectId,
      ref: "Collection",
    },

    record: {
      type: Schema.Types.ObjectId,
      ref: "Record",
    },

    column: {
      type: Schema.Types.ObjectId,
      ref: "Column",
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    action: {
      type: String,
      enum: ACTIVITY_ACTIONS,
      required: true,
    },

    message: {
      type: String,
      required: true,
      trim: true,
    },

    targetName: {
      type: String,
      trim: true,
      default: "",
    },

    before: {
      type: Schema.Types.Mixed,
      default: null,
    },

    after: {
      type: Schema.Types.Mixed,
      default: null,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    revertedAt: {
      type: Date,
      default: null,
    },

    revertedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    revertOf: {
      type: Schema.Types.ObjectId,
      ref: "Activity",
    },
  },
  {
    timestamps: true,
  }
);

// Feed queries: newest first, scoped to a workspace / module / record.
ActivitySchema.index({ workspace: 1, createdAt: -1 });
ActivitySchema.index({ module: 1, createdAt: -1 });
ActivitySchema.index({ record: 1, createdAt: -1 });
ActivitySchema.index({ user: 1, createdAt: -1 });

const Activity: Model<IActivity> =
  mongoose.models.Activity ||
  mongoose.model<IActivity>("Activity", ActivitySchema);

const TTL_INDEX_NAME = "activity_ttl";

/**
 * Applies env.activity_retention_days to the collection.
 *
 * A TTL index stores its window inside the index itself, so simply changing the
 * env var does nothing to an index that already exists. This drops and recreates
 * the index whenever the configured window differs from the live one, which is
 * what makes the setting changeable after the fact. 0 removes expiry entirely.
 */
export async function syncActivityRetention(): Promise<void> {
  const days = Number(env.activity_retention_days);
  const wanted = Number.isFinite(days) && days > 0 ? Math.round(days * 86400) : null;

  try {
    const indexes = await Activity.collection.indexes();
    const existing = indexes.find((i) => i.name === TTL_INDEX_NAME);
    const current =
      typeof existing?.expireAfterSeconds === "number"
        ? existing.expireAfterSeconds
        : null;

    if (current === wanted) return;

    if (existing) {
      await Activity.collection.dropIndex(TTL_INDEX_NAME);
    }

    if (wanted === null) {
      console.log("Activity retention: unlimited (TTL index removed)");
      return;
    }

    await Activity.collection.createIndex(
      { createdAt: 1 },
      { name: TTL_INDEX_NAME, expireAfterSeconds: wanted }
    );

    console.log(`Activity retention: ${days} days`);
  } catch (error) {
    // A failed TTL sync must never stop the server booting.
    console.error("Activity retention sync failed:", (error as Error).message);
  }
}

export default Activity;
