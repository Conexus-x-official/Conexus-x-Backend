import mongoose, { Document, Model, Schema } from "mongoose";

export interface INotification extends Document {
  user: mongoose.Types.ObjectId;

  workspace?: mongoose.Types.ObjectId;

  module?: mongoose.Types.ObjectId;

  record?: mongoose.Types.ObjectId;

  type:
    | "mention"
    | "assignment"
    | "invite"
    | "comment"
    | "status_change"
    | "deadline"
    | "system";

  title: string;

  message: string;

  isRead: boolean;

  readAt?: Date;

  /**
   * Type-specific extras the feed needs to render without a follow-up lookup —
   * an invite's role/inviter name, a mention's snippet author. Free-form like
   * Activity.metadata, for the same reason: every type would otherwise want
   * its own optional columns.
   */
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      index: true,
    },

    module: {
      type: Schema.Types.ObjectId,
      ref: "Module",
    },

    record: {
      type: Schema.Types.ObjectId,
      ref: "Record",
    },

    type: {
      type: String,
      enum: [
        "mention",
        "assignment",
        "invite",
        "comment",
        "status_change",
        "deadline",
        "system",
      ],
      default: "system",
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    message: {
      type: String,
      required: true,
      trim: true,
    },

    isRead: {
      type: Boolean,
      default: false,
    },

    readAt: {
      type: Date,
      default: null,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
NotificationSchema.index({ user: 1, isRead: 1 });
NotificationSchema.index({ user: 1, createdAt: -1 });

const Notification: Model<INotification> =
  mongoose.models.Notification ||
  mongoose.model<INotification>("Notification", NotificationSchema);

export default Notification;