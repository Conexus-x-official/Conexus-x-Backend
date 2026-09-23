import Notification, { INotification } from "../models/Notification";
import { emitChange } from "./realtime.service";

/**
 * The one seam every notification-producing trigger writes through — mentions
 * in amendments, workspace invites, and whatever comes next. Mirrors
 * logActivity()'s contract: best-effort, never throws, because a failed
 * notification must not fail the write that caused it.
 *
 * Deliberately does NOT cover Conexus Meet. A new message or an incoming call
 * has its own unread/typing/ringing machinery (services/realtime.service.ts
 * "conv:" rooms, Conversation.unreadFor) — duplicating that into a second
 * Notification row per message would give two systems one job. Meet stays
 * out of this file and out of the notification center entirely.
 */

export interface CreateNotificationInput {
    user: string;
    type: INotification["type"];
    title: string;
    message: string;
    workspace?: string;
    module?: string;
    record?: string;
    metadata?: Record<string, unknown>;
}

export const createNotification = async (
    input: CreateNotificationInput
): Promise<INotification | null> => {
    try {
        const notification = await Notification.create(input);

        emitChange({
            entity: "notification",
            action: "created",
            id: String(notification._id),
            data: notification,
            audience: [input.user]
        });

        return notification;
    } catch (error) {
        console.error("Notification create failed:", (error as Error).message);
        return null;
    }
};
