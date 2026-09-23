// models/User.ts

import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * The presence choices the picker offers, mirrored client-side in
 * app/lib/presence.ts — change both together. "offline" is the deliberate
 * "appear offline", not a derived state.
 */
export const USER_STATUSES = [
  "online",
  "busy",
  "dnd",
  "away",
  "offline",
] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Built-in, non-human accounts.
 *
 * They exist so the audit trail can say WHAT did something rather than
 * attributing a machine's work to whichever person happened to trigger it.
 * A bot has no password, cannot sign in (isActive: false blocks `protect`),
 * and is never returned by member listings.
 *
 * "announcer" is reserved but not built yet — the intended use is one message
 * addressed to every member at once instead of a per-person send.
 */
export const SYSTEM_USER_KEYS = ["automation", "announcer"] as const;

export type SystemUserKey = (typeof SYSTEM_USER_KEYS)[number];

/**
 * How the account describes itself.
 *
 * Stored so the product can diverge per type later (an organisation wants
 * departments and SSO; a personal account wants neither) and so the admin
 * dashboard can segment signups. "other" exists rather than a free-text box:
 * an unbounded field cannot be counted.
 */
export const ACCOUNT_TYPES = [
  "personal",
  "team",
  "organization",
  "other",
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * What the account PAYS, which is a different question from what it IS.
 *
 * Deliberately NOT folded into `accountType` above. That field is the signup
 * funnel's answer to "who are you" (personal / team / organization / other) and
 * is what acquisition is segmented on; this one is the billing tier and is what
 * spending is gated on. They look similar and drift apart immediately: a
 * "team" can be on Free and a "personal" account can be on Paid, and merging
 * them would have destroyed the funnel data to answer a billing question.
 */
export const ACCOUNT_PLANS = ["free", "paid", "enterprise"] as const;

export type AccountPlan = (typeof ACCOUNT_PLANS)[number];

/**
 * The AI spending ledger for one account.
 *
 * Counters live on the USER rather than in a per-call collection because this
 * is what has to be read and written on the hot path of every turn, and a sum
 * over a growing log is the wrong shape for a gate that runs before each
 * request. `lifetimeCredits` never resets, so support can still answer "how
 * much has this account ever used" without that log existing.
 *
 * The ALLOWANCE is not stored here — it comes from the plan (see
 * services/aiCredits.service.ts), so changing the free tier is a config edit
 * rather than a migration over every free row. `allowanceOverride` is the
 * escape hatch for a negotiated enterprise number.
 */
export interface AiCredits {
    /** Credits spent in the current period. Reset when the period rolls. */
    used: number;
    /** Per-account allowance, when it differs from the plan's. */
    allowanceOverride?: number | null;
    periodStart: Date;
    /** When `used` returns to zero — the lazy reset reads this. */
    periodEnd: Date;
    /** Never reset. */
    lifetimeCredits: number;
    lastUsedAt?: Date | null;
}

export interface IUser extends Document {
  firstName: string;
  lastName?: string;
  email: string;
  password?: string;
  avatar?: string;
  avatarPublicId?: string;
  phone?: string;
  googleId?: string;
  authProvider: "local" | "google";

  /**
   * A built-in actor rather than a person — see utils/systemUsers.ts.
   *
   * Null on every real account. Set, it is BOTH the marker and the key: it is
   * unique, so get-or-create can never race two "Automation" bots into
   * existence, and it is what the seeder looks a bot up by rather than
   * matching on a display name someone could change.
   */
  systemKey?: SystemUserKey | null;

  emailVerified: boolean;

  /**
   * What this account said about itself during signup.
   *
   * Kept on the USER rather than the workspace: it describes the person's
   * situation at the moment they joined, which is what an acquisition funnel
   * is measured on. A workspace can be renamed, transferred or deleted; the
   * answer to "where did you hear about us" must outlive all three.
   *
   * Every field is optional because the funnel is skippable at every step, and
   * a half-answered funnel is still worth more than none.
   */
  accountType?: AccountType | null;
  /** Free text on purpose - the option list will grow and old rows must survive. */
  referralSource?: string | null;
  organizationName?: string | null;
  teamSize?: string | null;
  /** Null until the funnel is finished; the flag that stops it reappearing. */
  onboardedAt?: Date | null;

  /**
   * Billing tier. Every account has one from the moment it is created — the
   * schema default writes it on the register and the Google-signup paths
   * alike, so there is no such thing as a user with no plan to fall back for.
   */
  plan: AccountPlan;

  /** Aquiline spending. Written at creation, so the gate never reads a gap. */
  aiCredits: AiCredits;

  /**
   * The pending signup code, and when it lapses.
   *
   * Both are cleared the moment the code is accepted, so "has an otpExpiresAt"
   * means "signed up and has not finished verifying" — which is exactly the
   * test login uses to decide whether to let someone in. Accounts that predate
   * this flow have neither field and are therefore never blocked by it.
   */
  otpCode?: string | null;
  otpExpiresAt?: Date | null;

  isActive: boolean;

  /**
   * How this person has set the app up for themselves.
   *
   * On the USER, not in the browser: a layout choice made on a laptop is still
   * the choice they made when they open the app on another machine, and
   * clearing site data should not silently undo it. The client keeps a local
   * mirror so the first paint needs no round trip, but this is the truth it
   * falls back to.
   *
   * A nested object rather than a flat `sidebarCollapsed` column so the next
   * preference is a key here, not another migration.
   */
  preferences: {
    /** Rail mode for the main navigation sidebar. */
    sidebarCollapsed: boolean;
    /**
     * Keyboard bindings, keyed by the shortcut ids the client knows about
     * (app/lib/shortcuts.ts). Deliberately an open bag: the SERVER has no
     * opinion on which shortcuts exist, so shipping a new one is a client
     * release, not a migration. Anything absent means "still the default".
     */
    shortcuts?: Record<string, string>;
  };

  /** What the user picked in the status menu — a preference, not a fact. */
  status: UserStatus;
  /** Bumped by the presence heartbeat; a stale value means the pick expired. */
  lastSeen?: Date;

  lastLogin?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },

    lastName: {
      type: String,
      required: function (this: IUser) {
        return this.authProvider === "local";
      },
      trim: true,
      maxlength: 50,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: function (this: IUser) {
        return this.authProvider === "local";
      },
      minlength: 8,
    },

    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },

    avatar: {
      type: String,
      default: "",
    },

    // Cloudinary public_id for `avatar` — needed to delete or replace the asset.
    avatarPublicId: {
      type: String,
      default: "",
    },

    phone: {
      type: String,
      default: "",
    },

    emailVerified: {
      type: Boolean,
      default: false,
    },

    // Funnel answers. Indexed where the admin dashboard will group by them.
    accountType: {
      type: String,
      enum: ACCOUNT_TYPES,
      default: null,
      index: true,
    },

    referralSource: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
      index: true,
    },

    organizationName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },

    teamSize: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20,
    },

    onboardedAt: {
      type: Date,
      default: null,
    },

    // Billing tier. Indexed: "how many accounts are on each plan" and "find the
    // paid ones" are the two questions this field exists to answer.
    plan: {
      type: String,
      enum: ACCOUNT_PLANS,
      default: "free",
      index: true,
    },

    /**
     * The AI ledger, written at creation by these defaults.
     *
     * `default: () => ({...})` on the parent, not a bare `{}`: the period has
     * to start from the moment THIS account was made, so the dates come from a
     * function evaluated per document. A shared literal would have frozen every
     * account's period to whenever the server process booted.
     */
    aiCredits: {
      type: new Schema(
        {
          used: { type: Number, default: 0, min: 0 },
          // null, not 0 — 0 is a real allowance meaning "cannot spend", so the
          // absence of an override has to be distinguishable from one set to
          // nothing.
          allowanceOverride: { type: Number, default: null },
          periodStart: { type: Date, default: Date.now },
          periodEnd: {
            type: Date,
            default: () => {
              const end = new Date();
              end.setMonth(end.getMonth() + 1);
              return end;
            },
          },
          lifetimeCredits: { type: Number, default: 0, min: 0 },
          lastUsedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: () => {
        const start = new Date();
        const end = new Date(start);
        end.setMonth(end.getMonth() + 1);

        return {
          used: 0,
          allowanceOverride: null,
          periodStart: start,
          periodEnd: end,
          lifetimeCredits: 0,
          lastUsedAt: null,
        };
      },
    },


    // `select: false` on both: a signup code is a short-lived credential and
    // has no business riding along on every user read (the roster, populated
    // `createdBy`, /auth/me). The two places that need it ask for it.
    otpCode: {
      type: String,
      default: null,
      select: false,
    },

    otpExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    systemKey: {
      type: String,
      enum: SYSTEM_USER_KEYS,
      // NO `default: null`, and the uniqueness now lives in the partial index
      // declared below rather than here. A sparse unique index skips documents
      // where the field is MISSING but still indexes an explicit null - so a
      // default of null made every human account collide with the previous one
      // (E11000 on systemKey_1), which blocked registration outright. Leaving
      // the field absent is what "not a bot" has to look like.
    },

    // _id: false — this is a plain settings bag, not a subdocument anyone
    // needs to address on its own.
    preferences: {
      type: new Schema(
        {
          sidebarCollapsed: { type: Boolean, default: false },
          // Map, not a nested Schema: the keys are the client's shortcut ids
          // and the whole point is that a new one needs no change here.
          shortcuts: { type: Map, of: String, default: () => ({}) },
        },
        { _id: false }
      ),
      default: () => ({ sidebarCollapsed: false, shortcuts: {} }),
    },

    status: {
      type: String,
      enum: USER_STATUSES,
      default: "online",
    },

    lastSeen: {
      type: Date,
    },

    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);


/**
 * Uniqueness for bot keys only.
 *
 * partialFilterExpression, not sparse: it indexes exactly the documents whose
 * systemKey is a real string, so two bots can never share a key while any
 * number of humans coexist with the field absent.
 * scripts/fix_system_key_index.ts migrates an existing database onto this.
 */
UserSchema.index(
  { systemKey: 1 },
  {
    unique: true,
    partialFilterExpression: { systemKey: { $type: "string" } },
  }
);


const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);

export default User;