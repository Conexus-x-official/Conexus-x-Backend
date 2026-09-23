import { Request, Response } from "express";
import mongoose from "mongoose";
import WorkspaceMember, { MEMBER_ROLES, MemberRole } from "../models/WorkspaceMember";
import Workspace from "../models/Workspace";
import Notification from "../models/Notification";
import User, { UserStatus } from "../models/User";
import { touchWorkspace } from "../utils/workspaceHelper";
import { logActivity } from "../services/activity.service";
import { emitChange, originOf } from "../services/realtime.service";
import { effectiveStatus } from "../services/presence.service";
import { paginationMeta, parsePagination } from "../utils/pagination";
import { createNotification } from "../services/notification.service";

interface AuthRequest extends Request {
    user?: {
        id: string;
    };
}


// Get workspace members
export const getWorkspaceMembers = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const { workspaceId } = req.params;


        const filter = { workspace: workspaceId };

        const pagination = parsePagination(req.query);

        const query = WorkspaceMember.find(filter)
            .populate(
                "user",
                "firstName lastName email avatar status lastSeen"
            )
            .lean();

        if (pagination.enabled) {
            query.skip(pagination.skip).limit(pagination.limit);
        }

        const members = await query;


        /**
         * `presence` is derived on read, never stored: the picked status only
         * counts while the heartbeat is fresh, so the roster cannot show someone
         * online hours after they closed the tab. The raw pick and lastSeen stay
         * server-side — the roster has no use for them, and "appear offline"
         * would leak if it shipped them.
         */
        const withPresence = members.map((member) => {

            // `.lean()` types the ref as its ObjectId, so the populated shape
            // has to be reasserted here.
            const user = member.user as unknown as
                | (Record<string, unknown> & { status?: UserStatus; lastSeen?: Date })
                | null;

            if (!user) return member;

            const { status, lastSeen, ...publicUser } = user;

            return {
                ...member,
                user: {
                    ...publicUser,
                    presence: effectiveStatus({ status, lastSeen })
                }
            };

        });


        if (!pagination.enabled) {
            return res.json({ members: withPresence });
        }

        return res.json({
            members: withPresence,
            pagination: paginationMeta(
                await WorkspaceMember.countDocuments(filter),
                pagination
            )
        });


    } catch (error: any) {

        return res.status(500).json({
            message: error.message
        });

    }

};




// Add member to workspace
export const addWorkspaceMember = async (
    req: AuthRequest,
    res: Response
) => {

    try {


        const {
            workspaceId
        } = req.params;


        const { email, userId, role } = req.body;

        if (!mongoose.Types.ObjectId.isValid(workspaceId as string)) {
            return res.status(400).json({
                message: "Invalid workspace ID format"
            });
        }

        let user;
        if (email) {
            user = await User.findOne({ email });
        } else if (userId) {
            if (mongoose.Types.ObjectId.isValid(userId as string)) {
                user = await User.findById(userId as string);
            } else {
                // Fallback in case user typed an email in the User ID field
                user = await User.findOne({ email: userId as string });
            }
        } else {
            return res.status(400).json({
                message: "User email or ID is required"
            });
        }


        if (!user) {

            return res.status(404).json({
                message: "User not found"
            });

        }

        const exists = await WorkspaceMember.findOne({

            workspace: workspaceId,

            user: user._id

        });



        if (exists) {

            return res.status(400).json({
                message: "User already member"
            });

        }



        /**
         * PENDING, not active: this is an invite, and the person has not agreed
         * to anything yet. They become an active member only through
         * acceptWorkspaceInvite below, triggered from their notification —
         * every membership check in the app already gates on status "active"
         * (getMembership, resolveModuleAccess, the socket subscribe handler),
         * so a pending row grants no access on its own.
         */
        const member = await WorkspaceMember.create({

            workspace: new mongoose.Types.ObjectId(workspaceId as string),

            user: user._id,

            role: role || "member",

            status: "pending",

            invitedBy: req.user?.id ? new mongoose.Types.ObjectId(req.user.id) : undefined

        });

        await touchWorkspace(workspaceId as string);

        const memberLabel =
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email;

        await logActivity({
            workspace: String(workspaceId),
            user: req.user?.id,
            action: "member_invited",
            targetName: memberLabel,
            after: member.role,
            message: `invited ${memberLabel} as ${member.role}`,
            metadata: { memberUserId: String(user._id), role: member.role }
        });

        const [workspace, inviter] = await Promise.all([
            Workspace.findById(workspaceId).select("name icon"),
            req.user?.id ? User.findById(req.user.id).select("firstName lastName") : null
        ]);

        const inviterLabel =
            `${inviter?.firstName ?? ""} ${inviter?.lastName ?? ""}`.trim() || "Someone";
        const workspaceName = workspace?.name ?? "a workspace";

        void createNotification({
            user: String(user._id),
            workspace: String(workspaceId),
            type: "invite",
            title: "Workspace invitation",
            message: `${inviterLabel} invited you to join "${workspaceName}" as ${member.role}`,
            metadata: {
                workspaceName,
                workspaceIcon: workspace?.icon ?? "",
                role: member.role,
                invitedBy: inviterLabel
            }
        });

        // Populated so the client can name the person it just added without a
        // follow-up read — the members list is invalidated, not awaited.
        await member.populate("user", "firstName lastName email avatar");

        emitChange({
            entity: "member",
            action: "created",
            id: String(member._id),
            workspaceId: String(workspaceId),
            data: member,
            actorId: req.user?.id,
            originId: originOf(req)
        });

        return res.status(201).json({

            message: "Invitation sent",

            member

        });


    } catch (error: any) {

        return res.status(500).json({
            message: error.message
        });

    }

};





// Remove member
export const removeWorkspaceMember = async (
    req: AuthRequest,
    res: Response
) => {

    try {


        const {
            workspaceId,
            userId
        } = req.params;



        // Populated before the delete so the log can name who was removed.
        const removed = await WorkspaceMember.findOneAndDelete({

            workspace: workspaceId,

            user: userId

        }).populate("user", "firstName lastName email");

        await touchWorkspace(workspaceId as string);

        if (removed) {
            const removedUser = removed.user as unknown as {
                firstName?: string;
                lastName?: string;
                email?: string;
            } | null;

            const memberLabel =
                `${removedUser?.firstName ?? ""} ${removedUser?.lastName ?? ""}`.trim() ||
                removedUser?.email ||
                "a member";

            await logActivity({
                workspace: String(workspaceId),
                user: req.user?.id,
                action: "member_removed",
                targetName: memberLabel,
                before: removed.role,
                after: null,
                message: `removed ${memberLabel} from the workspace`,
                metadata: { memberUserId: String(userId) }
            });
        }

        emitChange({
            entity: "member",
            action: "deleted",
            id: String(userId),
            workspaceId: String(workspaceId),
            actorId: req.user?.id,
            originId: originOf(req)
        });

        return res.json({

            message: "Member removed successfully"

        });



    } catch (error: any) {

        return res.status(500).json({
            message: error.message
        });

    }

};


const isMemberRole = (value: unknown): value is MemberRole =>
    typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);


/**
 * PUT /api/workspace-members/:workspaceId/:userId  { role }
 *
 * Role assignment. The rules live here rather than in the client so the console,
 * the API key and the UI all get the same answer:
 *  - only an active owner or admin of THAT workspace may change roles;
 *  - only an owner may hand out or take away ownership;
 *  - a workspace can never be left without an owner.
 */
export const updateWorkspaceMemberRole = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const { workspaceId, userId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) {
            return res.status(400).json({ message: "Invalid workspace ID format" });
        }

        const { role } = req.body;

        if (!isMemberRole(role)) {
            return res.status(400).json({
                message: `Role must be one of: ${MEMBER_ROLES.join(", ")}`
            });
        }

        // Never trust a client-supplied actor — the caller is the token holder.
        const actor = await WorkspaceMember.findOne({
            workspace: workspaceId,
            user: req.user?.id,
            status: "active"
        });

        if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
            return res.status(403).json({
                message: "Only an owner or admin can change roles"
            });
        }

        const member = await WorkspaceMember.findOne({
            workspace: workspaceId,
            user: userId
        }).populate("user", "firstName lastName email avatar");

        if (!member) {
            return res.status(404).json({
                message: "Member not found in this workspace"
            });
        }

        const previousRole = member.role;

        if (previousRole === role) {
            return res.json({ message: "Role unchanged", member });
        }

        if ((role === "owner" || previousRole === "owner") && actor.role !== "owner") {
            return res.status(403).json({
                message: "Only an owner can grant or remove ownership"
            });
        }

        if (previousRole === "owner") {
            const owners = await WorkspaceMember.countDocuments({
                workspace: workspaceId,
                role: "owner",
                status: "active"
            });

            if (owners <= 1) {
                return res.status(400).json({
                    message: "This is the last owner — promote someone else first"
                });
            }
        }

        member.role = role;
        await member.save();

        await touchWorkspace(String(workspaceId));

        const memberUser = member.user as unknown as {
            firstName?: string;
            lastName?: string;
            email?: string;
        } | null;

        const memberLabel =
            `${memberUser?.firstName ?? ""} ${memberUser?.lastName ?? ""}`.trim() ||
            memberUser?.email ||
            "a member";

        await logActivity({
            workspace: String(workspaceId),
            user: req.user?.id,
            action: "member_role_changed",
            targetName: memberLabel,
            before: previousRole,
            after: role,
            message: `changed ${memberLabel} from ${previousRole} to ${role}`,
            metadata: { memberUserId: String(userId) }
        });

        emitChange({
            entity: "member",
            action: "updated",
            id: String(member._id),
            workspaceId: String(workspaceId),
            data: member,
            actorId: req.user?.id,
            originId: originOf(req)
        });

        return res.json({ message: "Role updated", member });

    } catch (error: any) {

        console.error("Update member role error:", error.message);

        return res.status(500).json({ message: "Server error" });

    }

};


/**
 * POST /api/workspace-members/:workspaceId/accept
 *
 * The other half of addWorkspaceMember's pending row: the invited user, and
 * only the invited user (req.user.id, never a body/param), turns their own
 * pending row active. This is the ONLY place a WorkspaceMember goes
 * pending -> active — see the comment on the pending create above for why
 * every access check in the app already treats that as "not really a member
 * yet".
 */
export const acceptWorkspaceInvite = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const { workspaceId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) {
            return res.status(400).json({ message: "Invalid workspace ID format" });
        }

        const member = await WorkspaceMember.findOne({
            workspace: workspaceId,
            user: req.user?.id,
            status: "pending"
        });

        if (!member) {
            return res.status(404).json({ message: "No pending invitation found" });
        }

        member.status = "active";
        member.joinedAt = new Date();
        await member.save();

        await member.populate("user", "firstName lastName email avatar");

        await touchWorkspace(String(workspaceId));

        const memberUser = member.user as unknown as {
            firstName?: string;
            lastName?: string;
            email?: string;
        } | null;

        const memberLabel =
            `${memberUser?.firstName ?? ""} ${memberUser?.lastName ?? ""}`.trim() ||
            memberUser?.email ||
            "a member";

        await logActivity({
            workspace: String(workspaceId),
            user: req.user?.id,
            action: "member_joined",
            targetName: memberLabel,
            after: member.role,
            message: `${memberLabel} joined the workspace`
        });

        // The invite is resolved — nothing left for it to ask.
        await Notification.deleteMany({
            user: req.user?.id,
            workspace: workspaceId,
            type: "invite"
        });

        emitChange({
            entity: "member",
            action: "updated",
            id: String(member._id),
            workspaceId: String(workspaceId),
            data: member,
            actorId: req.user?.id,
            originId: originOf(req)
        });

        // The accepting user's OWN other tabs/devices are not in the workspace
        // room yet (they only just joined) — audience delivery reaches them
        // directly so both their member list AND their "my workspaces" list
        // (a separate tag from a separate query) pick the new one up.
        emitChange({
            entity: "member",
            action: "updated",
            id: String(member._id),
            workspaceId: String(workspaceId),
            audience: [String(req.user?.id)]
        });

        emitChange({
            entity: "workspace",
            action: "updated",
            id: String(workspaceId),
            audience: [String(req.user?.id)]
        });

        return res.json({ message: "Joined workspace", member });

    } catch (error: any) {

        console.error("Accept invite error:", error.message);

        return res.status(500).json({ message: "Server error" });

    }

};


/**
 * POST /api/workspace-members/:workspaceId/decline
 *
 * Removes the pending row outright rather than marking it "inactive" — an
 * "inactive" status elsewhere in this model means someone who WAS active and
 * left or was removed, which is a different fact than "never joined".
 */
export const declineWorkspaceInvite = async (
    req: AuthRequest,
    res: Response
) => {

    try {

        const { workspaceId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) {
            return res.status(400).json({ message: "Invalid workspace ID format" });
        }

        const member = await WorkspaceMember.findOneAndDelete({
            workspace: workspaceId,
            user: req.user?.id,
            status: "pending"
        });

        if (!member) {
            return res.status(404).json({ message: "No pending invitation found" });
        }

        await touchWorkspace(String(workspaceId));

        await logActivity({
            workspace: String(workspaceId),
            user: req.user?.id,
            action: "member_invite_declined",
            before: member.role,
            after: null,
            message: "declined an invitation to join the workspace"
        });

        await Notification.deleteMany({
            user: req.user?.id,
            workspace: workspaceId,
            type: "invite"
        });

        emitChange({
            entity: "member",
            action: "deleted",
            id: String(member._id),
            workspaceId: String(workspaceId),
            actorId: req.user?.id,
            originId: originOf(req)
        });

        return res.json({ message: "Invitation declined" });

    } catch (error: any) {

        console.error("Decline invite error:", error.message);

        return res.status(500).json({ message: "Server error" });

    }

};
