import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";
import Pit from "../models/Pit";


export interface AuthRequest extends Request {
    user?: {
        id: string;
    };
}


export const protect = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {

    try {

        // 1. Check for JWT Bearer token first
        const authHeader = req.headers.authorization;

        if (authHeader) {

            const token = authHeader.split(" ")[1];

            const decoded = jwt.verify(
                token,
                process.env.JWT_SECRET!
            ) as {
                userId: string;
            };

            req.user = {
                id: decoded.userId
            };

            return next();

        }


        // 2. Check for x-api-key header
        const apiKey = req.headers["x-api-key"] as string | undefined;

        if (apiKey) {

            const pit = await Pit.findOne({
                token: apiKey,
                isActive: true
            }).select("user");

            if (!pit) {
                return res.status(401).json({
                    message: "Invalid API key"
                });
            }

            const user = await User.findOne({
                _id: pit.user,
                isActive: true
            }).select("_id");

            if (!user) {
                return res.status(401).json({
                    message: "Invalid API key"
                });
            }

            req.user = {
                id: user._id.toString()
            };

            return next();

        }


        // 3. No auth provided
        return res.status(401).json({
            message: "No token or API key provided"
        });


    } catch (error) {

        return res.status(401).json({
            message: "Invalid token"
        });

    }

};