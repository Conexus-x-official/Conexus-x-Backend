import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth.middleware";
import Notification from "../models/Notification";
import { paginationMeta, parsePagination } from "../utils/pagination";

/**
 * The notification center's own CRUD. Deliberately never scoped by a client-
 * supplied workspace or user id — everything here reads/writes `req.user.id`
 * only, because a notification belongs to exactly one person and there is no
 * "which workspace's notifications" question to answer (Meet, which does have
 * one, keeps its own separate unread system — see notification.service.ts).
 */

// GET /api/notifications?isRead=&type=
export const getNotifications = async (req: AuthRequest, res: Response) => {
    try {
        const filter: Record<string, unknown> = { user: req.user?.id };

        if (req.query.isRead === "true") filter.isRead = true;
        if (req.query.isRead === "false") filter.isRead = false;

        if (typeof req.query.type === "string" && req.query.type) {
            filter.type = req.query.type;
        }

        const pagination = parsePagination(req.query);

        const query = Notification.find(filter).sort({ createdAt: -1 });

        if (pagination.enabled) {
            query.skip(pagination.skip).limit(pagination.limit);
        }

        const notifications = await query;

        if (!pagination.enabled) {
            return res.json({ notifications });
        }

        return res.json({
            notifications,
            pagination: paginationMeta(await Notification.countDocuments(filter), pagination)
        });
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};

// GET /api/notifications/unread-count
export const getUnreadCount = async (req: AuthRequest, res: Response) => {
    try {
        const count = await Notification.countDocuments({
            user: req.user?.id,
            isRead: false
        });

        res.json({ count });
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};

// PATCH /api/notifications/:id/read
export const markNotificationRead = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(String(id))) {
            return res.status(400).json({ message: "Invalid notification id" });
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: id, user: req.user?.id },
            { isRead: true, readAt: new Date() },
            { returnDocument: "after" }
        );

        if (!notification) {
            return res.status(404).json({ message: "Notification not found" });
        }

        res.json({ notification });
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};

// POST /api/notifications/read-all
export const markAllNotificationsRead = async (req: AuthRequest, res: Response) => {
    try {
        await Notification.updateMany(
            { user: req.user?.id, isRead: false },
            { isRead: true, readAt: new Date() }
        );

        res.json({ message: "All notifications marked read" });
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};

// DELETE /api/notifications/:id
export const deleteNotification = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(String(id))) {
            return res.status(400).json({ message: "Invalid notification id" });
        }

        const notification = await Notification.findOneAndDelete({
            _id: id,
            user: req.user?.id
        });

        if (!notification) {
            return res.status(404).json({ message: "Notification not found" });
        }

        res.json({ message: "Notification dismissed" });
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};
