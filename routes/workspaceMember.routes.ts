import { Router } from "express";

import {
    getWorkspaceMembers,
    addWorkspaceMember,
    updateWorkspaceMemberRole,
    removeWorkspaceMember,
    acceptWorkspaceInvite,
    declineWorkspaceInvite
} from "../controllers/workspaceMember.controller";

import { protect } from "../middleware/auth.middleware";


const router = Router();



router.get(
    "/:workspaceId",
    protect,
    getWorkspaceMembers
);



router.post(
    "/:workspaceId",
    protect,
    addWorkspaceMember
);



router.post(
    "/:workspaceId/accept",
    protect,
    acceptWorkspaceInvite
);



router.post(
    "/:workspaceId/decline",
    protect,
    declineWorkspaceInvite
);



router.put(
    "/:workspaceId/:userId",
    protect,
    updateWorkspaceMemberRole
);



router.delete(
    "/:workspaceId/:userId",
    protect,
    removeWorkspaceMember
);



export default router;