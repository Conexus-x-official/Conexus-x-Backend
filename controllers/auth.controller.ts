import { Request, Response } from "express";
import User, { ACCOUNT_TYPES, USER_STATUSES } from "../models/User";
import { generateOtp, otpExpiry, sendOtpEmail } from "../services/otp.service";
import { hashPassword, comparePassword } from "../utils/hash";
import { createToken } from "../services/jwt.service";
import { ensureApiKey } from "../services/apiKey.service";
import {
    buildGoogleAuthUrl,
    createOAuthState,
    exchangeCodeForTokens,
    fetchGoogleProfile,
    isGoogleConfigured,
    verifyOAuthState,
    OAuthMode
} from "../services/google.service";
import { isCloudinaryConfigured, uploadAvatar } from "../services/cloudinary.service";
import { effectiveStatus, isUserStatus } from "../services/presence.service";
import { announcePresence } from "../services/realtime.service";
import { AuthRequest } from "../middleware/auth.middleware";
import env from "../config/env";


export const register = async (
    req: Request,
    res: Response
) => {

    try {

        const {
            firstName,
            lastName,
            email,
            password
        } = req.body;


        const existingUser = await User.findOne({
            email
        });


        if (existingUser) {
            return res.status(400).json({
                message: "User already exists"
            });
        }


        const hashedPassword =
            await hashPassword(password);



        const otp = generateOtp();

        const user = await User.create({
            firstName,
            lastName,
            email,
            password: hashedPassword,
            otpCode: otp,
            otpExpiresAt: otpExpiry()
        });

        await ensureApiKey(user);


        /**
         * A failed send must NOT fail the request.
         *
         * The account already exists at this point, so answering 500 would
         * leave the caller believing registration failed while the email is
         * taken — and their next attempt gets "User already exists" with no way
         * forward. Resend is the recovery path, so the response says so.
         */
        let delivered = true;

        try {
            await sendOtpEmail(email, otp);
        } catch (mailError: any) {
            delivered = false;
            console.error("OTP send failed:", mailError?.message);
        }


        /**
         * An EXPLICIT shape, never the mongoose document.
         *
         * `select: false` on otpCode/otpExpiresAt only governs QUERIES — a
         * document handed back by .create() still carries every value that was
         * just written, so returning `user` here published the signup code in
         * the register response and defeated the whole verification step. (It
         * published the password hash too, which it had been doing all along.)
         * Allow-list the fields; do not try to subtract the secret ones.
         */
        res.json({
            message: delivered
                ? "User created. Check your email for the verification code."
                : "User created, but the code could not be sent. Use Resend.",
            emailSent: delivered,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                emailVerified: user.emailVerified
            }
        });


    } catch (error: any) {
        console.error("Registration error:", error);
        
        // Handle Mongoose validation errors
        if (error.name === "ValidationError") {
            return res.status(400).json({
                message: "Validation failed",
                errors: Object.values(error.errors).map((err: any) => err.message)
            });
        }

        res.status(500).json({
            message: "Server error",
            error: error.message
        });
    }

};

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        // Find user by email. otpExpiresAt is select:false, so ask for it —
        // it is the gate below.
        const user = await User.findOne({ email }).select("+otpExpiresAt");
        if (!user) {
            return res.status(400).json({ message: "Invalid email or password" });
        }

        /**
         * Unverified signups are blocked, but ONLY those that actually went
         * through the code flow.
         *
         * The test is "has a pending otpExpiresAt", not "emailVerified is
         * false". Every account created before this flow existed has
         * emailVerified false and no pending code — gating on the boolean
         * alone would have locked out every existing user on deploy.
         */
        if (!user.emailVerified && user.otpExpiresAt) {
            return res.status(403).json({
                message: "Verify your email first — check your inbox for the code.",
                needsVerification: true,
                email: user.email
            });
        }

        // Google-only accounts have no password to compare
        if (!user.password) {
            return res.status(400).json({
                message: "This account uses Google sign-in. Continue with Google instead."
            });
        }

        // Compare password
        const isMatch = await comparePassword(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid email or password" });
        }

        // Ensure user has an API key
        await ensureApiKey(user);

        // Create JWT token
        const token = createToken(user._id.toString());

        // Return expected response
        res.json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                avatar: user.avatar,
                status: user.status,
                preferences: user.preferences
            }
        });
    } catch (error: any) {
        console.error("Login error:", error);
        res.status(500).json({
            message: "Server error",
            error: error.message
        });
    }
};

const GOOGLE_ERRORS = {
    not_configured: "not_configured",
    invalid_state: "invalid_state",
    missing_code: "missing_code",
    no_email: "no_email",
    exchange_failed: "exchange_failed"
} as const;


// GET /api/auth/google — sends the browser to Google's consent screen
export const googleAuth = (req: Request, res: Response) => {

    if (!isGoogleConfigured()) {
        return res.redirect(
            `${env.site_url}/auth/callback#error=${GOOGLE_ERRORS.not_configured}`
        );
    }

    const mode: OAuthMode =
        req.query.mode === "register" ? "register" : "login";

    return res.redirect(buildGoogleAuthUrl(createOAuthState(mode)));

};


// GET /api/auth/google/callback — Google redirects here with ?code&state
/**
 * Google hands back a lh3.googleusercontent.com URL that can rotate or 404 once
 * the user changes their Google picture. Mirror it into Cloudinary so the avatar
 * we render is ours. Best-effort: a failure falls back to the Google URL.
 */
const mirrorGooglePicture = async (
    pictureUrl: string | undefined,
    userId: string
): Promise<{ avatar: string; avatarPublicId: string } | null> => {
    if (!pictureUrl || !isCloudinaryConfigured()) return null;

    try {
        const result = await uploadAvatar(pictureUrl, userId);
        return { avatar: result.url, avatarPublicId: result.publicId };
    } catch (error: any) {
        console.error("Google avatar mirror failed:", error.message);
        return null;
    }
};


export const googleCallback = async (req: Request, res: Response) => {

    const fail = (reason: string) =>
        res.redirect(`${env.site_url}/auth/callback#error=${encodeURIComponent(reason)}`);

    try {

        const { code, state, error } = req.query;

        if (error) {
            return fail(String(error));
        }

        if (!code) {
            return fail(GOOGLE_ERRORS.missing_code);
        }

        try {
            verifyOAuthState(state);
        } catch {
            return fail(GOOGLE_ERRORS.invalid_state);
        }

        const tokens = await exchangeCodeForTokens(String(code));

        const profile = await fetchGoogleProfile(tokens.access_token);

        if (!profile.email) {
            return fail(GOOGLE_ERRORS.no_email);
        }

        const email = profile.email.toLowerCase();


        let user = await User.findOne({
            $or: [{ googleId: profile.sub }, { email }]
        });


        if (!user) {

            const [firstFromName, ...restOfName] = (profile.name || "").split(" ");

            user = await User.create({
                firstName: profile.given_name || firstFromName || "User",
                lastName: profile.family_name || restOfName.join(" ") || undefined,
                email,
                googleId: profile.sub,
                authProvider: "google",
                avatar: profile.picture || "",
                emailVerified: Boolean(profile.email_verified),
                lastLogin: new Date()
            });

            await ensureApiKey(user);

            const mirrored = await mirrorGooglePicture(profile.picture, user._id.toString());

            if (mirrored) {
                user.avatar = mirrored.avatar;
                user.avatarPublicId = mirrored.avatarPublicId;
                await user.save();
            }

        } else {

            // Existing local account signing in with Google for the first time
            if (!user.googleId) {
                user.googleId = profile.sub;
            }

            // Only fill a blank avatar — never overwrite a picture the user uploaded.
            if (!user.avatar && profile.picture) {
                const mirrored = await mirrorGooglePicture(profile.picture, user._id.toString());

                if (mirrored) {
                    user.avatar = mirrored.avatar;
                    user.avatarPublicId = mirrored.avatarPublicId;
                } else {
                    user.avatar = profile.picture;
                }
            }

            user.emailVerified = user.emailVerified || Boolean(profile.email_verified);
            user.lastLogin = new Date();

            await user.save();

            await ensureApiKey(user);

        }


        const token = createToken(user._id.toString());

        // Fragment, not query string: the token never reaches a server log or referrer header
        return res.redirect(
            `${env.site_url}/auth/callback#token=${encodeURIComponent(token)}`
        );


    } catch (error: any) {

        console.error("Google OAuth error:", error.message);

        return fail(GOOGLE_ERRORS.exchange_failed);

    }

};


// GET /api/auth/me — resolves the signed-in user from the Bearer token
/**
 * Finish signup: exchange the emailed code for a verified account.
 *
 * The comparison is deliberately narrow. An expired code is rejected with its
 * own message rather than a generic failure, because "wrong code" and "too
 * late" need different actions from the user — retyping versus resending.
 */
export const verifyOtp = async (req: Request, res: Response) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({
                message: "Email and code are required"
            });
        }

        // Both fields are `select: false` on the schema, so they have to be
        // asked for explicitly here.
        const user = await User.findOne({ email }).select(
            "+otpCode +otpExpiresAt"
        );

        if (!user) {
            return res.status(404).json({ message: "No account for that email" });
        }

        if (user.emailVerified) {
            return res.json({ message: "Email already verified", verified: true });
        }

        if (!user.otpCode || !user.otpExpiresAt) {
            return res.status(400).json({
                message: "No code is pending. Request a new one."
            });
        }

        if (user.otpExpiresAt.getTime() < Date.now()) {
            return res.status(400).json({
                message: "That code has expired. Request a new one.",
                expired: true
            });
        }

        if (String(user.otpCode) !== String(otp).trim()) {
            return res.status(400).json({ message: "That code is not correct" });
        }

        user.emailVerified = true;
        // Cleared on success: a spent code must not be replayable, and an
        // absent otpExpiresAt is what tells login this account is settled.
        user.otpCode = null;
        user.otpExpiresAt = null;

        await user.save();

        /**
         * A SESSION, not just a boolean.
         *
         * Proving control of the inbox is the same proof a password login
         * gives, so sending them back to a sign-in form to prove it again is
         * ceremony. It is also what makes the setup funnel possible: creating a
         * workspace, inviting people and saving the funnel answers all sit
         * behind `protect`, and without a token here every one of them would
         * have to be stashed in the browser and replayed later.
         */
        const token = createToken(user._id.toString());

        return res.json({
            message: "Email verified",
            verified: true,
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                avatar: user.avatar,
                emailVerified: true
            }
        });
    } catch (error: any) {
        console.error("OTP verify error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};


/**
 * Records what the signup funnel asked.
 *
 * Deliberately NOT part of workspace creation: the funnel is skippable, the
 * answers are about the person rather than the workspace, and an analytics
 * dashboard needs them whether or not a workspace was ever built.
 *
 * Every field is optional and unknown keys are ignored, so adding a question to
 * the funnel never needs a matching migration here.
 */
export const saveOnboarding = async (
    req: AuthRequest,
    res: Response
) => {
    try {
        const { accountType, referralSource, organizationName, teamSize } =
            req.body ?? {};

        const update: Record<string, unknown> = { onboardedAt: new Date() };

        // Validated against the enum rather than trusted: this column is
        // grouped by in the admin dashboard, and one stray value there becomes
        // a permanent extra bar on every chart.
        if (accountType && ACCOUNT_TYPES.includes(accountType)) {
            update.accountType = accountType;
        }

        if (typeof referralSource === "string" && referralSource.trim()) {
            update.referralSource = referralSource.trim().slice(0, 80);
        }

        if (typeof organizationName === "string" && organizationName.trim()) {
            update.organizationName = organizationName.trim().slice(0, 120);
        }

        if (typeof teamSize === "string" && teamSize.trim()) {
            update.teamSize = teamSize.trim().slice(0, 20);
        }

        await User.findByIdAndUpdate(req.user?.id, update);

        return res.json({ message: "Saved" });
    } catch (error: any) {
        console.error("Onboarding save error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};


/** Issue a fresh code, replacing whatever was outstanding. */
export const resendOtp = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: "No account for that email" });
        }

        if (user.emailVerified) {
            return res.json({ message: "Email already verified", verified: true });
        }

        const otp = generateOtp();

        user.otpCode = otp;
        user.otpExpiresAt = otpExpiry();

        await user.save();

        try {
            await sendOtpEmail(email, otp);
        } catch (mailError: any) {
            console.error("OTP resend failed:", mailError?.message);
            return res.status(502).json({
                message: "Could not send the email. Try again shortly."
            });
        }

        return res.json({ message: "A new code is on its way" });
    } catch (error: any) {
        console.error("OTP resend error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};


export const me = async (req: AuthRequest, res: Response) => {

    try {

        const user = await User.findById(req.user?.id).select(
            "-password -apiKey"
        );

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                avatar: user.avatar,
                authProvider: user.authProvider,
                status: user.status,
                lastSeen: user.lastSeen,
                presence: effectiveStatus(user),
                // Rides along on the call the client already makes on arrival,
                // so a fresh browser lays the sidebar out correctly on the
                // first paint after sign-in rather than a beat later.
                preferences: user.preferences,
                // Same reasoning: the plan decides what the app offers, so it
                // must be known before the first render rather than fetched
                // once something has already been drawn wrongly.
                plan: user.plan ?? "free"
            }
        });

    } catch (error: any) {

        console.error("Fetch profile error:", error.message);

        res.status(500).json({ message: "Server error" });

    }

};


// PATCH /api/auth/status — the user picks their own presence
export const updateStatus = async (req: AuthRequest, res: Response) => {

    try {

        const { status } = req.body;

        if (!isUserStatus(status)) {
            return res.status(400).json({
                message: `Status must be one of: ${USER_STATUSES.join(", ")}`
            });
        }

        // Picking a status also counts as activity, so the pick is live at once.
        const user = await User.findByIdAndUpdate(
            req.user?.id,
            { status, lastSeen: new Date() },
            { returnDocument: "after" }
        ).select("status lastSeen");

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // A picked status is the one presence change no socket lifecycle sees,
        // so it is announced explicitly. Everyone else's dot moves at once
        // instead of on their next members refetch.
        void announcePresence(String(req.user?.id));

        res.json({
            message: "Status updated",
            status: user.status,
            lastSeen: user.lastSeen,
            presence: effectiveStatus(user)
        });

    } catch (error: any) {

        console.error("Update status error:", error.message);

        res.status(500).json({ message: "Server error" });

    }

};


/**
 * PATCH /api/auth/preferences — the caller's own UI settings.
 *
 * A partial merge, not a replace: the body names only what changed, so a client
 * that predates the next preference cannot blank it by omission. Unknown keys
 * are ignored rather than rejected — this is a settings bag, and a stray field
 * from an older build is not worth a 400.
 */
export const updatePreferences = async (req: AuthRequest, res: Response) => {

    try {

        const { sidebarCollapsed, shortcuts } = req.body;

        const patch: Record<string, unknown> = {};

        if (typeof sidebarCollapsed === "boolean") {
            patch["preferences.sidebarCollapsed"] = sidebarCollapsed;
        }

        /**
         * Keyboard bindings arrive as a whole map and REPLACE the stored one,
         * because "reset this shortcut to its default" is expressed by the key
         * being absent — a per-key merge would make a reset impossible to say.
         *
         * The server does not know which shortcut ids exist (that ships with
         * the client), so it validates SHAPE only: string keys, string values,
         * both bounded. That is enough to stop the settings bag being used as
         * arbitrary storage without pinning the API to today's shortcut list.
         */
        if (shortcuts !== undefined) {
            if (
                typeof shortcuts !== "object" ||
                shortcuts === null ||
                Array.isArray(shortcuts)
            ) {
                return res.status(400).json({ message: "shortcuts must be an object" });
            }

            const entries = Object.entries(shortcuts as Record<string, unknown>);

            if (entries.length > 50) {
                return res.status(400).json({ message: "Too many shortcuts" });
            }

            const clean: Record<string, string> = {};

            for (const [key, value] of entries) {
                if (typeof value !== "string") {
                    return res.status(400).json({ message: `Shortcut "${key}" must be a string` });
                }
                if (key.length > 64 || value.length > 64) {
                    return res.status(400).json({ message: `Shortcut "${key}" is too long` });
                }
                if (value.trim()) clean[key] = value.trim().toLowerCase();
            }

            patch["preferences.shortcuts"] = clean;
        }

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ message: "No known preference in body" });
        }

        const user = await User.findByIdAndUpdate(
            req.user?.id,
            { $set: patch },
            { returnDocument: "after" }
        ).select("preferences");

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({
            message: "Preferences updated",
            preferences: user.preferences
        });

    } catch (error: any) {

        console.error("Update preferences error:", error.message);

        res.status(500).json({ message: "Server error" });

    }

};


// POST /api/auth/heartbeat — "still here"; keeps the picked status from expiring
export const heartbeat = async (req: AuthRequest, res: Response) => {

    try {

        const user = await User.findByIdAndUpdate(
            req.user?.id,
            { lastSeen: new Date() },
            { returnDocument: "after" }
        ).select("status lastSeen");

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({
            status: user.status,
            lastSeen: user.lastSeen,
            presence: effectiveStatus(user)
        });

    } catch (error: any) {

        console.error("Heartbeat error:", error.message);

        res.status(500).json({ message: "Server error" });

    }

};
