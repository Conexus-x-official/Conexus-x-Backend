import mongoose, { Document, Model, Schema } from "mongoose";
import { randomBytes } from "crypto";

/**
 * A public, shareable form bound to ONE module.
 *
 * It is the config behind the "Form" view: the owner picks which of the
 * module's columns appear, in what order, which are required, where a
 * submission lands, and how the thank-you screen reads — then publishes it and
 * gets a `/f/<publicId>` link anyone on the internet can fill in.
 *
 * One form per module (unique index on `module`) — the same "one remembered
 * config per view" shape the other views keep in localStorage, promoted to the
 * server here because a public URL and a submission count cannot live in a
 * browser.
 *
 * A submission goes through routes/publicForm.routes.ts, which carries NO
 * `protect`. That controller re-checks `isPublished`, runs the honeypot + a
 * per-IP throttle, and coerces every value to its column's type before writing
 * — a public write path trusts nothing.
 */

/** The column types a stranger can meaningfully fill in — person/people/file/
 *  relation/reference are deliberately never offered on a public form. */
export const PUBLIC_FORM_FIELD_TYPES = [
  "text",
  "number",
  "status",
  "date",
  "timeline",
  "email",
  "phone",
  "checkbox",
  "dropdown",
  "link",
  "rating",
] as const;

export const FORM_THEMES = ["minimal", "classic", "bold"] as const;
export type FormTheme = (typeof FORM_THEMES)[number];

export interface IFormField {
  column: mongoose.Types.ObjectId;
  /** Shown to the submitter instead of the raw column name, when set. */
  label: string;
  required: boolean;
  position: number;
}

export interface IForm extends Document {
  workspace: mongoose.Types.ObjectId;
  module: mongoose.Types.ObjectId;
  /** Where a submission is filed. */
  targetCollection: mongoose.Types.ObjectId;

  /** URL slug — the whole public surface hangs off this one opaque string. */
  publicId: string;

  title: string;
  description: string;
  submitLabel: string;

  fields: IFormField[];

  theme: FormTheme;

  /** The screen a submitter sees after sending — greeting + a soft CRM pitch. */
  successTitle: string;
  successBody: string;
  /** Whether the thank-you screen offers a "create your own" sign-up button. */
  showSignupCta: boolean;

  isPublished: boolean;
  submissionCount: number;

  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * `<title-slug>-<8 hex>` — readable in the address bar ("/f/contact-us-3f9a2b1c")
 * while the 32-bit random tail keeps it from being guessable or enumerable
 * (the link IS the access control — the public route has no auth). Stable for
 * the life of the form; "Reset link" regenerates the tail (and picks up a new
 * title) when a URL needs to be invalidated.
 */
export const newPublicId = (title?: string) =>
  `${slugify(title || "") || "form"}-${randomBytes(4).toString("hex")}`;

const FormFieldSchema = new Schema<IFormField>(
  {
    column: { type: Schema.Types.ObjectId, ref: "Column", required: true },
    label: { type: String, default: "", trim: true, maxlength: 120 },
    required: { type: Boolean, default: false },
    position: { type: Number, default: 0 },
  },
  { _id: false }
);

const FormSchema = new Schema<IForm>(
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
      unique: true,
    },
    targetCollection: {
      type: Schema.Types.ObjectId,
      ref: "Collection",
      required: true,
    },

    publicId: {
      type: String,
      required: true,
      unique: true,
      default: () => newPublicId(),
    },

    title: { type: String, default: "Untitled form", trim: true, maxlength: 160 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    submitLabel: { type: String, default: "Submit", trim: true, maxlength: 40 },

    fields: { type: [FormFieldSchema], default: [] },

    theme: { type: String, enum: FORM_THEMES, default: "minimal" },

    successTitle: {
      type: String,
      default: "Thank you!",
      trim: true,
      maxlength: 160,
    },
    successBody: {
      type: String,
      default: "Your response has been recorded. We appreciate you taking the time.",
      trim: true,
      maxlength: 2000,
    },
    showSignupCta: { type: Boolean, default: true },

    isPublished: { type: Boolean, default: false },
    submissionCount: { type: Number, default: 0 },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

const Form: Model<IForm> =
  mongoose.models.Form || mongoose.model<IForm>("Form", FormSchema);

export default Form;
