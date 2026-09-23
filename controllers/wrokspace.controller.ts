import { Request, Response } from "express";
import Workspace from "../models/Workspace";
import WorkspaceMember from "../models/WorkspaceMember";
import mongoose from "mongoose";
import { paginationMeta, parsePagination } from "../utils/pagination";
import Module from "../models/Module";
import Column from "../models/Column";
import Record from "../models/Record";
import Collection from "../models/Collection";
import Activity from "../models/Activity";
import Comment from "../models/Comment";
import File from "../models/File";
import Notification from "../models/Notification";
import { touchWorkspace } from "../utils/workspaceHelper";
import { emitChange, originOf } from "../services/realtime.service";

// Extend Request type to include user information from auth middleware
export interface AuthRequest extends Request {
    user?: {
        id: string;
        [key: string]: any;
    };
}

// Create Workspace
export const createWorkspace = async (req: AuthRequest, res: Response) => {
    try {
        const { name, icon, banner } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                message: "Unauthorized: User not found in request"
            });
        }

        // Generate a URL-friendly unique slug (required by Workspace schema)
        const baseSlug = name
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, "") // remove non-alphanumeric chars except space and hyphen
            .replace(/[\s_-]+/g, "-")  // replace spaces/underscores with a single hyphen
            .replace(/^-+|-+$/g, "");  // trim leading/trailing hyphens
        
        const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;

        const workspace = await Workspace.create({
            name,
            slug,
            // Trusted only as an opaque key — the client decides what it draws.
            icon: typeof icon === "string" ? icon.trim().slice(0, 40) : "",
            banner: typeof banner === "string" ? banner.trim().slice(0, 300) : "",
            owner: userId
        });

        await WorkspaceMember.create({
            workspace: workspace._id,
            user: userId,
            role: "owner"
        });

        return res.status(201).json({
            message: "Workspace created successfully",
            workspace
        });
    } catch (error: any) {
        return res.status(500).json({
            message: error.message
        });
    }
};

// Get All User Workspaces
export const getWorkspaces = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                message: "Unauthorized: User not found in request"
            });
        }

        const pagination = parsePagination(req.query);

        // A PENDING row is an invite the user has not accepted yet — it must
        // not show up as a workspace they are already in. See the "pending"
        // create in workspaceMember.controller.ts addWorkspaceMember.
        const membershipQuery = WorkspaceMember.find({
            user: userId,
            status: "active"
        }).populate("workspace");

        if (pagination.enabled) {
            membershipQuery.skip(pagination.skip).limit(pagination.limit);
        }

        const memberships = await membershipQuery;

        // Collect workspace IDs and count modules for each
        const workspaceIds = memberships
            .map((m: any) => m.workspace?._id)
            .filter(Boolean);

        const moduleCounts = await Module.aggregate([
            { $match: { workspace: { $in: workspaceIds } } },
            { $group: { _id: "$workspace", count: { $sum: 1 } } }
        ]);

        const countMap: Record<string, number> = {};
        for (const entry of moduleCounts) {
            countMap[entry._id.toString()] = entry.count;
        }

        // Attach totalModules to each membership's workspace
        const workspaces = memberships.map((m: any) => {
            const ws = m.workspace?.toObject ? m.workspace.toObject() : m.workspace;
            return {
                ...m.toObject(),
                workspace: ws
                    ? { ...ws, totalModules: countMap[ws._id?.toString()] || 0 }
                    : ws,
            };
        });

        if (!pagination.enabled) {
            return res.json({ workspaces });
        }

        return res.json({
            workspaces,
            pagination: paginationMeta(
                await WorkspaceMember.countDocuments({ user: userId }),
                pagination
            )
        });
    } catch (error: any) {
        return res.status(500).json({
            message: error.message
        });
    }
};

// Get Single Workspace
export const getWorkspace = async (req: Request, res: Response) => {
    try {
        const workspace = await Workspace.findById(req.params.id);

        if (!workspace) {
            return res.status(404).json({
                message: "Workspace not found"
            });
        }

        return res.json({
            workspace
        });
    } catch (error: any) {
        return res.status(500).json({
            message: error.message
        });
    }
};

// Update Workspace
export const updateWorkspace = async (req: Request, res: Response) => {
    try {
        /**
         * Only the fields a rename/settings form actually sends. Spreading
         * req.body here would let a caller rewrite owner or slug.
         */
        const patch: Record<string, unknown> = {};

        if (typeof req.body.name === "string") patch.name = req.body.name;
        if (typeof req.body.description === "string") patch.description = req.body.description;
        if (typeof req.body.icon === "string") patch.icon = req.body.icon.trim().slice(0, 40);
        // Same allowlist rule as icon: named explicitly so a caller still
        // cannot reach owner or slug through this endpoint.
        if (typeof req.body.banner === "string")
            patch.banner = req.body.banner.trim().slice(0, 300);

        const workspace = await Workspace.findByIdAndUpdate(
            req.params.id,
            patch,
            {
                returnDocument: "after"
            }
        );

        if (workspace) {
            await touchWorkspace(workspace._id);
        }

        emitChange({
            entity: "workspace",
            action: "updated",
            id: String(req.params.id),
            workspaceId: String(req.params.id),
            data: workspace,
            actorId: (req as AuthRequest).user?.id,
            originId: originOf(req)
        });

        return res.json({
            message: "Workspace updated",
            workspace
        });
    } catch (error: any) {
        return res.status(500).json({
            message: error.message
        });
    }
};

// Delete Workspace
export const deleteWorkspace = async (req: Request, res: Response) => {
        try {
            const workspaceId = req.params.id;
            // Start transaction
            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                // Delete related data
                // Modules belonging to workspace
                const modules = await Module.find({ workspace: workspaceId }).session(session);
                const moduleIds = modules.map(b => b._id);

                // Delete records, collections, columns, activities, comments, files, notifications
                await Record.deleteMany({ workspace: workspaceId }).session(session);
                await Collection.deleteMany({ module: { $in: moduleIds } }).session(session);
                await Column.deleteMany({ module: { $in: moduleIds } }).session(session);
                await Activity.deleteMany({ workspace: workspaceId }).session(session);
                await Comment.deleteMany({ workspace: workspaceId }).session(session);
                await File.deleteMany({ workspace: workspaceId }).session(session);
                await Notification.deleteMany({ workspace: workspaceId }).session(session);

                // Delete modules
                await Module.deleteMany({ workspace: workspaceId }).session(session);

                // Delete workspace members
                await WorkspaceMember.deleteMany({ workspace: workspaceId }).session(session);

                // Finally delete workspace
                await Workspace.findByIdAndDelete(workspaceId).session(session);

                await session.commitTransaction();
                session.endSession();
                emitChange({
                    entity: "workspace",
                    action: "deleted",
                    id: String(workspaceId),
                    workspaceId: String(workspaceId),
                    actorId: (req as AuthRequest).user?.id,
                    originId: originOf(req)
                });

                return res.json({ message: "Workspace and related data deleted" });
            } catch (innerErr) {
                await session.abortTransaction();
                session.endSession();
                throw innerErr;
            }
        } catch (error: any) {
            return res.status(500).json({ message: error.message });
        }
    };
