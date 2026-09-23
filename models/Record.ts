import mongoose, { Document, Model, Schema } from "mongoose";

export interface IRecord extends Document {
  workspace: mongoose.Types.ObjectId;
  module: mongoose.Types.ObjectId;
  collectionName: mongoose.Types.ObjectId;

  /**
   * The record this one hangs under, or null for a top-level row.
   *
   * A sub-record is an ordinary Record: same module, same collection, same
   * cells table. Only two things differ — it is never listed by the board
   * (getCollectionRecords filters on `parentRecord: null`) and its cells are
   * written against columns whose `scope` is "subrecord", which is what lets a
   * sub-record carry a completely different column set from its parent.
   */
  parentRecord: mongoose.Types.ObjectId | null;

  name: string;
  position: number;
  createdBy: mongoose.Types.ObjectId;
  isCompleted: boolean;
  /** A per-record flag anyone with board access can toggle — "starred", email style. */
  isImportant: boolean;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const RecordSchema = new Schema<IRecord>(
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
      required: true,
      index: true,
    },

    collectionName: {
      type: Schema.Types.ObjectId,
      ref: "Collection",
      required: true,
      index: true,
    },

    parentRecord: {
      type: Schema.Types.ObjectId,
      ref: "Record",
      default: null,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    position: {
      type: Number,
      default: 0,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isCompleted: {
      type: Boolean,
      default: false,
    },

    isImportant: {
      type: Boolean,
      default: false,
    },

    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);


RecordSchema.index({ createdBy: 1 });
RecordSchema.index({ module: 1, collectionName: 1, position: 1 });
// Sub-records are read one parent at a time and ordered within that parent.
RecordSchema.index({ parentRecord: 1, position: 1 });

const Record: Model<IRecord> =
  mongoose.models.Record ||
  mongoose.model<IRecord>("Record", RecordSchema);

export default Record;