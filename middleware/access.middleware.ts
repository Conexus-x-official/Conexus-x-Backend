// middleware/access.middleware.ts

import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "./auth.middleware";
import { resolveModuleAccess } from "../services/access.service";
import Collection from "../models/Collection";
import Column from "../models/Column";
import Record from "../models/Record";
import RecordValue from "../models/RecordValue";
import Automation from "../models/Automation";
// The Comment model backs amendments — see amendment.controller.ts for why the
// storage keeps its original name.
import Comment from "../models/Comment";
import Form from "../models/Form";
import WorkspaceMember from "../models/WorkspaceMember";

/**
 * Board-level access, applied at the route rather than inside every controller.
 *
 * Each board-scoped resource carries the board it belongs to, so the resolvers
 * below turn whatever id the route was given back into a module id, and
 * services/access.service.ts decides. A route with no resolver is a route with
 * no access control — keep them in the same file as the routes they guard.
 */

export interface ModuleAccessRequest extends AuthRequest {
    /** Set once access is granted, so controllers need not look it up again. */
    moduleAccess?: { moduleId: string; workspaceId: string; role?: string };
}

type Resolver = (req: AuthRequest) => Promise<string | undefined>;

const fromParam = (name: string): Resolver => async (req) =>
    req.params[name] as string | undefined;

/** Every board-scoped model stores `module`, so one lookup is always enough. */
const fromModel = (
    model: mongoose.Model<any>,
    param: string
): Resolver => async (req) => {
    const id = req.params[param];

    if (!id || !mongoose.isValidObjectId(String(id))) return undefined;

    const document = await model.findById(id).select("module");

    return document?.module ? String(document.module) : undefined;
};

/** POST /api/record-values carries its parent record in the body, not the path. */
const fromRecordBody: Resolver = async (req) => {
    const recordId = (req.body ?? {}).record;

    if (!recordId || !mongoose.isValidObjectId(String(recordId))) return undefined;

    const record = await Record.findById(recordId).select("module");

    return record?.module ? String(record.module) : undefined;
};

export const moduleFrom = {
    param: fromParam("moduleId"),
    collectionParam: fromModel(Collection, "collectionId"),
    columnParam: fromModel(Column, "columnId"),
    recordParam: fromModel(Record, "recordId"),
    recordValueParam: fromModel(RecordValue, "recordValueId"),
    amendmentParam: fromModel(Comment, "amendmentId"),
    formParam: fromModel(Form, "formId"),
    recordBody: fromRecordBody
};

/**
 * The automation exception.
 *
 * PUT/DELETE on an automation used to resolve the board from the recipe and go
 * through requireModuleAccess. A WORKSPACE-scoped recipe has no board — its
 * `module` is null on purpose — so that resolver returns undefined and every
 * edit to one would be refused.
 *
 * So: board recipes are gated on the board exactly as before, and workspace
 * recipes are gated on active workspace membership instead. That is the right
 * test rather than a weaker one — a workspace recipe is authored against the
 * workspace, and the engine still only fires it on modules where the
 * triggering user's own write landed, so it grants no reach they did not have.
 */
export const requireAutomationAccess = async (
    req: ModuleAccessRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const id = req.params.automationId;

        if (!id || !mongoose.isValidObjectId(String(id))) {
            return res.status(400).json({ message: "Invalid automation id" });
        }

        const automation = await Automation.findById(id)
            .select("module scope workspace")
            .lean();

        if (!automation) {
            return res.status(404).json({ message: "Automation not found" });
        }

        if (!automation.module) {
            const membership = await WorkspaceMember.findOne({
                workspace: automation.workspace,
                user: req.user?.id,
                status: "active"
            });

            if (!membership) {
                return res
                    .status(403)
                    .json({ message: "Not a member of this workspace" });
            }

            req.moduleAccess = {
                // No board is involved, and a caller that reads this expecting
                // one would be wrong about what it is looking at.
                moduleId: "",
                workspaceId: String(automation.workspace),
                role: membership.role
            };

            return next();
        }

        const decision = await resolveModuleAccess(
            req.user?.id,
            String(automation.module)
        );

        if (!decision.allowed) {
            return res.status(decision.status).json({ message: decision.message });
        }

        req.moduleAccess = {
            moduleId: decision.moduleId as string,
            workspaceId: decision.workspaceId as string,
            role: decision.role
        };

        return next();
    } catch (error) {
        console.error("Automation access check failed:", (error as Error).message);
        return res.status(500).json({ message: "Could not check access" });
    }
};

export const requireModuleAccess =
    (resolve: Resolver) =>
        async (req: ModuleAccessRequest, res: Response, next: NextFunction) => {
            try {
                const moduleId = await resolve(req);

                const decision = await resolveModuleAccess(req.user?.id, moduleId);

                if (!decision.allowed) {
                    return res
                        .status(decision.status)
                        .json({ message: decision.message });
                }

                req.moduleAccess = {
                    moduleId: decision.moduleId as string,
                    workspaceId: decision.workspaceId as string,
                    role: decision.role
                };

                return next();
            } catch (error: any) {
                console.error("Access check failed:", error.message);
                return res.status(500).json({ message: "Access check failed" });
            }
        };
