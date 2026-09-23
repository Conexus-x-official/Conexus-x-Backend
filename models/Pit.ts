import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * The API key store, kept off the User document on purpose: a secret sitting
 * on the same document that every populate("user") and profile read touches
 * is one stray `.select()` away from leaking. Pit is the single source of
 * truth for a user's key (see auth.middleware.ts and apiKey.controller.ts) —
 * do not also cache the token on User, or the two will drift.
 */
export interface IPit extends Document {
  user: mongoose.Types.ObjectId;
  name: string;
  token: string;
  isActive: boolean;
  /** When `token` was last (re)issued — the cooldown in apiKey.service.ts reads this. */
  lastGeneratedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PitSchema = new Schema<IPit>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // Snapshot of the owning user's display name, so the key is identifiable
    // in the database without a populate/join.
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastGeneratedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const Pit: Model<IPit> =
  mongoose.models.Pit || mongoose.model<IPit>("Pit", PitSchema);

export default Pit;
