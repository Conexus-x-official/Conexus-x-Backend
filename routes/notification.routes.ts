import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    getNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification
} from "../controllers/notification.controller";

const router = Router();

router.get("/", protect, getNotifications);
router.get("/unread-count", protect, getUnreadCount);
router.post("/read-all", protect, markAllNotificationsRead);
router.patch("/:id/read", protect, markNotificationRead);
router.delete("/:id", protect, deleteNotification);

export default router;
