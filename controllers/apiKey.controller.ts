import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import User from "../models/User";
import Pit from "../models/Pit";
import { generateApiKey, ensureApiKey, nextAllowedAt } from "../services/apiKey.service";


const displayName = (user: { firstName: string; lastName?: string }) =>
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim();


// GET /api/api-key — return the current user's API key (generate if not present)
export const getApiKey = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const user = await User.findById(req.user?.id).select("firstName lastName");

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        await ensureApiKey(user);

        const pit = await Pit.findOne({ user: user._id });

        res.json({
            apiKey: pit!.token,
            nextAllowedAt: nextAllowedAt(pit!.lastGeneratedAt).toISOString()
        });

    } catch (error: any) {
        console.error("Get API key error:", error);
        res.status(500).json({
            message: "Server error",
            error: error.message
        });
    }

};


// POST /api/api-key/generate — regenerate/change the API key
export const generateKey = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const user = await User.findById(req.user?.id).select("firstName lastName");

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        const existing = await Pit.findOne({ user: user._id });

        if (existing) {

            const allowedAt = nextAllowedAt(existing.lastGeneratedAt);

            if (allowedAt.getTime() > Date.now()) {
                return res.status(429).json({
                    message: "You can only change your PIT key once every 20 minutes",
                    nextAllowedAt: allowedAt.toISOString()
                });
            }

        }

        const token = generateApiKey();
        const generatedAt = new Date();

        const pit = await Pit.findOneAndUpdate(
            { user: user._id },
            { token, name: displayName(user), isActive: true, lastGeneratedAt: generatedAt },
            { upsert: true, returnDocument: "after" }
        );

        res.json({
            message: "PIT key updated",
            apiKey: pit!.token,
            nextAllowedAt: nextAllowedAt(generatedAt).toISOString()
        });

    } catch (error: any) {
        console.error("Generate API key error:", error);
        res.status(500).json({
            message: "Server error",
            error: error.message
        });
    }

};
