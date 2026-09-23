// services/agentTools.service.ts

import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";

import Workspace from "../models/Workspace";
import WorkspaceMember from "../models/WorkspaceMember";
import Module from "../models/Module";
import Collection from "../models/Collection";
import Column from "../models/Column";
import Record from "../models/Record";
import RecordValue from "../models/RecordValue";
// Amendments. The model kept its original name — see amendment.controller.ts.
import Comment from "../models/Comment";

import { touchWorkspace } from "../utils/workspaceHelper";
import { logActivity } from "../services/activity.service";
import { runAutomations } from "../services/automation.service";
import {
    getMembership,
    isWorkspaceManager,
    resolveModuleAccess
} from "../services/access.service";
import {
    BlueprintPlan,
    buildBlueprint,
    describeBlueprint,
    parseBlueprint
} from "./blueprint.service";

/**
 * What Aquiline can actually do.
 *
 * Two rules hold this file together:
 *
 *  1. TOKENS. Every description below is one line, and every result is the
 *     smallest JSON that still lets the model take the next step — ids and
 *     names, never whole documents. The model pays for each of these strings on
 *     every single request, so a paragraph here is a permanent tax.
 *
 *  2. AUTHORITY. A tool is not a bypass. Each executor re-checks membership and
 *     module access for the calling user exactly like the REST routes do, so a
 *     prompt-injected instruction can never reach data the user could not open
 *     by clicking. Writes go through the same touchWorkspace + logActivity +
 *     runAutomations path, so a change made by chat is indistinguishable from
 *     one made by hand.
 */

export interface ToolContext {
    userId: string;
    /** Where the user is standing — lets the model skip a lookup call. */
    workspaceId?: string;
    moduleId?: string;
}

/**
 * One thing the panel can render as itself — a badge in the entity's own
 * colour rather than a name in quotes.
 */
export interface EntityRef {
    kind: "workspace" | "module" | "collection" | "column" | "record" | "value" | "amendment";
    id: string;
    name: string;
    /** The entity's own colour where it has one; the panel hashes the id if not. */
    color?: string;
}

/** What the UI needs to refresh itself, collected as the loop runs. */
export interface AppliedAction extends EntityRef {
    tool: string;
    workspaceId?: string;
    moduleId?: string;
}

export interface PendingAction {
    tool: string;
    /** One line the panel shows above the authorise button. */
    intent: string;
    kind: string;
    name: string;
    /** Every id or name this will delete — chipped in the prompt. */
    targets?: string[];
    /** A whole structure to build, drawn as a tree before it is authorised. */
    plan?: BlueprintPlan;
    /** Replayed verbatim on authorisation — re-checked before it runs. */
    input: Record<string, unknown>;
}

interface ToolOutcome {
    /** JSON-serialisable payload handed back to the model. */
    result: unknown;
    /** Present only when something was actually written. */
    applied?: AppliedAction;
    /** A batch wrote more than one thing. */
    appliedMany?: AppliedAction[];
    /** Present when the tool needs the user to authorise it first. */
    pending?: PendingAction;
    /**
     * Entities this call merely LOOKED AT. A list_* tool changes nothing, so
     * without this the panel had no way to know that the names in "the
     * collections are A, B and C" were real entities worth rendering as badges.
     * Built from rows already fetched — it costs no extra tokens, because it is
     * never sent to the model.
     */
    seen?: EntityRef[];
}

export const isConfirmableTool = (tool: string) => NEEDS_AUTHORISATION.has(tool);

const oid = (value: string) => new mongoose.Types.ObjectId(String(value));

const fail = (message: string): ToolOutcome => ({ result: { error: message } });

/** Membership check, shared by every workspace-scoped tool. */
const requireWorkspace = async (userId: string, workspaceId: string) => {
    if (!mongoose.isValidObjectId(workspaceId)) return "Invalid workspace id";
    const membership = await getMembership(workspaceId, userId);
    return membership ? null : "You are not a member of that workspace";
};

/** Module access check, shared by every module-scoped tool. */
const requireBoard = async (userId: string, moduleId: string) => {
    const decision = await resolveModuleAccess(userId, moduleId);
    return decision.allowed ? null : decision.message;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turn whatever the model passed into a real id.
 *
 * History reaches the model as plain text — the tool_use blocks from earlier
 * turns are not replayed — so by the time the user answers "yes" to a delete,
 * the id from the previous turn is gone. Accepting the NAME as well is what
 * makes a two-turn confirmation work without a second lookup round.
 */
const resolveTargetId = async (
    kind: string,
    idOrName: string,
    context: ToolContext
): Promise<string | null> => {

    if (mongoose.isValidObjectId(idOrName)) return idOrName;

    const name = idOrName.trim();
    if (!name) return null;

    const exact = new RegExp(`^${escapeRegex(name)}$`, "i");

    if (kind === "workspace") {
        const memberships = await WorkspaceMember.find({ user: context.userId, status: "active" })
            .populate("workspace", "name")
            .lean();

        const hit = memberships.find((membership) => {
            const workspace = membership.workspace as unknown as { name?: string } | null;
            return workspace?.name?.toLowerCase() === name.toLowerCase();
        });

        const workspace = hit?.workspace as unknown as { _id?: unknown } | null;
        return workspace?._id ? String(workspace._id) : null;
    }

    if (kind === "module") {
        if (!context.workspaceId) return null;
        const moduleItem = await Module.findOne({
            workspace: oid(context.workspaceId),
            name: exact
        }).select("_id");
        return moduleItem ? String(moduleItem._id) : null;
    }

    // A collection, record or column is only ever named relative to the module in view.
    if (!context.moduleId) return null;

    const found =
        kind === "collection"
            ? await Collection.findOne({ module: oid(context.moduleId), name: exact }).select("_id")
            : kind === "record"
                ? await Record.findOne({
                    module: oid(context.moduleId),
                    name: exact,
                    parentRecord: null
                }).select("_id")
                : await Column.findOne({
                    module: oid(context.moduleId),
                    name: exact,
                    scope: { $ne: "subrecord" }
                }).select("_id");

    return found ? String(found._id) : null;
};

/**
 * The tool schemas sent to the model. Kept deliberately terse — see rule 1.
 */
export const AGENT_TOOLS: Anthropic.Tool[] = [
    {
        name: "list_workspaces",
        description: "List the user's workspaces (id, name).",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "create_workspace",
        description: "Create a workspace.",
        input_schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"]
        }
    },
    {
        name: "list_modules",
        description: "List modules in a workspace (id, name).",
        input_schema: {
            type: "object",
            properties: { workspaceId: { type: "string" } },
            required: ["workspaceId"]
        }
    },
    {
        name: "create_module",
        description: "Create a module in a workspace.",
        input_schema: {
            type: "object",
            properties: {
                workspaceId: { type: "string" },
                name: { type: "string" },
                visibility: { type: "string", enum: ["workspace", "private"] }
            },
            required: ["workspaceId", "name"]
        }
    },
    {
        name: "list_collections",
        description: "List collections in a module (id, name).",
        input_schema: {
            type: "object",
            properties: { moduleId: { type: "string" } },
            required: ["moduleId"]
        }
    },
    {
        name: "create_collection",
        description: "Create a collection in a module.",
        input_schema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
                name: { type: "string" }
            },
            required: ["moduleId", "name"]
        }
    },
    {
        name: "list_columns",
        description: "List a module's columns (id, name, type).",
        input_schema: {
            type: "object",
            properties: { moduleId: { type: "string" } },
            required: ["moduleId"]
        }
    },
    {
        name: "create_column",
        description:
            "Add a column. type: text|number|status|date|person|checkbox|email|phone|link. Pass labels for status.",
        input_schema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
                name: { type: "string" },
                type: { type: "string" },
                labels: { type: "array", items: { type: "string" } }
            },
            required: ["moduleId", "name", "type"]
        }
    },
    {
        name: "list_records",
        description: "List records in a collection (id, name). Max 25.",
        input_schema: {
            type: "object",
            properties: { collectionId: { type: "string" } },
            required: ["collectionId"]
        }
    },
    {
        name: "create_record",
        description: "Create records in a collection. Pass names to create several.",
        input_schema: {
            type: "object",
            properties: {
                collectionId: { type: "string" },
                names: { type: "array", items: { type: "string" } }
            },
            required: ["collectionId", "names"]
        }
    },
    {
        name: "set_cell",
        description: "Set one record's value for one column.",
        input_schema: {
            type: "object",
            properties: {
                recordId: { type: "string" },
                columnId: { type: "string" },
                value: { type: "string" }
            },
            required: ["recordId", "columnId", "value"]
        }
    },
    {
        name: "post_amendment",
        description:
            "Post an amendment on a record — a written note for people to read (the user may call it an update or a note). Never a column value. Record by id or exact name.",
        input_schema: {
            type: "object",
            properties: {
                recordId: { type: "string" },
                message: { type: "string" }
            },
            required: ["recordId", "message"]
        }
    },
    {
        name: "create_blueprint",
        description:
            "Set up a whole structure at once from a description (\"a sales CRM\"). One call: modules, their collections, columns and starter records. Set newWorkspaceName ONLY to create a new workspace — omit it to build into the one in CONTEXT. Never put an id here.",
        input_schema: {
            type: "object",
            properties: {
                newWorkspaceName: { type: "string" },
                modules: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            collections: { type: "array", items: { type: "string" } },
                            columns: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        type: { type: "string" },
                                        labels: { type: "array", items: { type: "string" } }
                                    },
                                    required: ["name", "type"]
                                }
                            },
                            records: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        collection: { type: "string" },
                                        names: { type: "array", items: { type: "string" } }
                                    },
                                    required: ["collection", "names"]
                                }
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["modules"]
        }
    },
    {
        name: "update_entity",
        description:
            "Rename or edit by id or exact name. Fields: name, color, visibility (module), description, collection (moves a record). Always use this to rename \u2014 never delete and recreate.",
        input_schema: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["workspace", "module", "collection", "column", "record"]
                },
                id: { type: "string" },
                name: { type: "string" },
                color: { type: "string" },
                visibility: { type: "string", enum: ["workspace", "private"] },
                description: { type: "string" },
                collection: { type: "string" }
            },
            required: ["kind", "id"]
        }
    },
    {
        name: "delete_entity",
        description:
            "Delete by id or exact name. Use ids for several at once. The app asks the user to authorise it.",
        input_schema: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["workspace", "module", "collection", "record", "column"]
                },
                id: { type: "string" },
                ids: { type: "array", items: { type: "string" } }
            },
            required: ["kind"]
        }
    }
];

/** Status columns need labels; these are the same defaults the REST route uses. */
const STATUS_COLOURS = ["#94A3B8", "#F59E0B", "#EF4444", "#22C55E", "#6C5CE7"];

/**
 * The column types the schema accepts. A model is perfectly capable of asking
 * for "currency"; anything off this list becomes text rather than a 500.
 */
const COLUMN_TYPES = [
    "text", "number", "status", "date", "person", "checkbox",
    "email", "phone", "link", "dropdown", "timeline", "file", "rating"
] as const;

type ColumnType = (typeof COLUMN_TYPES)[number];

const asColumnType = (value: string): ColumnType =>
    (COLUMN_TYPES as readonly string[]).includes(value)
        ? (value as ColumnType)
        : "text";

type ToolInput = Record<string, unknown>;
/**
 * Whether the caller has the user's authorisation.
 *
 * Deliberately NOT a field on the tool input: anything in the schema is
 * something the model can set for itself, and it will. Only server code — the
 * /confirm route, or an already-authorised batch — can pass this.
 */
export interface ExecuteOptions {
    authorised?: boolean;
}

/**
 * Tools that must be authorised before they run.
 *
 * Deleting anything, and creating the two structural levels — a workspace or a
 * module — are the calls a misread sentence should never be able to make on its
 * own. Collections, records, columns and values stay immediate: gating the
 * everyday flow would make the agent tedious rather than safe.
 */
const NEEDS_AUTHORISATION = new Set([
    "delete_entity",
    "create_workspace",
    "create_module",
    "create_blueprint"
]);

/** Every target of one call — a batch delete passes `ids`. */
const targetsOf = (input: ToolInput): string[] => {
    const many = Array.isArray(input.ids)
        ? (input.ids as unknown[]).map((value) => String(value).trim()).filter(Boolean)
        : [];

    if (many.length > 0) return many;

    const single = String(input.id ?? "").trim();
    return single ? [single] : [];
};

/** What the user is being asked to authorise, in their own words. */
const describeIntent = (tool: string, input: ToolInput): string => {
    if (tool === "create_workspace") {
        return `Create the workspace "${String(input.name ?? "").trim()}"`;
    }

    if (tool === "create_module") {
        return `Create the module "${String(input.name ?? "").trim()}"`;
    }

    const kind = String(input.kind ?? "entity");
    const targets = targetsOf(input);

    // The names are chipped in the sentence above, so the button line only
    // needs the count.
    if (targets.length > 1) return `Delete ${targets.length} ${kind}s`;

    return `Delete the ${kind} "${targets[0] ?? ""}"`;
};


const str = (input: ToolInput, key: string) => String(input[key] ?? "").trim();

export async function executeTool(
    name: string,
    rawInput: unknown,
    context: ToolContext,
    options: ExecuteOptions = {}
): Promise<ToolOutcome> {

    const input = (rawInput ?? {}) as ToolInput;
    const { userId } = context;

    // One gate for every guarded tool, so a new one cannot forget to ask.
    if (NEEDS_AUTHORISATION.has(name) && options.authorised !== true) {

        /**
         * A blueprint is parsed and CAPPED before the preview is drawn, so what
         * the user authorises is exactly what gets built — never an optimistic
         * version of it.
         */
        if (name === "create_blueprint") {
            const plan = parseBlueprint(input, context.workspaceId);

            if (!plan) {
                return fail(
                    "That plan is empty or too large — name a workspace, or ask for fewer modules."
                );
            }

            /**
             * The id in CONTEXT comes from the browser and can be stale — it
             * survives in localStorage after the workspace is deleted. Trusting
             * it produced a plan that promised "building into this workspace"
             * and then failed on the press, so it is verified here: it must
             * still exist AND the caller must still be a member.
             */
            if (!plan.workspace && plan.workspaceId) {
                const existing = await Workspace.findById(plan.workspaceId).select("name");

                const membership = existing
                    ? await getMembership(plan.workspaceId, userId)
                    : null;

                if (existing && membership) {
                    plan.existingWorkspaceName = existing.name;
                } else {
                    plan.workspaceId = undefined;
                }
            }

            // Nowhere to build. Handed back to the model rather than to the
            // user, so it can name a workspace and finish in the same turn.
            if (!plan.workspace && !plan.workspaceId) {
                return fail(
                    "There is no workspace to build into. Call create_blueprint again with newWorkspaceName set to a name that suits this business."
                );
            }

            return {
                result: {
                    needs_confirmation: true,
                    message: "Show the user the plan and wait for them to authorise it."
                },
                pending: {
                    tool: name,
                    intent: describeBlueprint(plan),
                    kind: "workspace",
                    name: plan.workspace ?? "this workspace",
                    targets: [],
                    plan,
                    input: { plan }
                }
            };
        }

        return {
            result: {
                needs_confirmation: true,
                message:
                    "Tell the user what this will do and wait for them to authorise it. Do not call again yourself."
            },
            pending: {
                tool: name,
                intent: describeIntent(name, input),
                kind: String(input.kind ?? (name === "create_workspace" ? "workspace" : "module")),
                name: String(input.name ?? input.id ?? ""),
                targets: name === "delete_entity" ? targetsOf(input) : [],
                // Anything the model invented that looks like a self-grant is
                // dropped before the payload goes anywhere near the client.
                input: (({ confirm, authorised, ...rest }) => rest)(input)
            }
        };
    }

    switch (name) {

        case "list_workspaces": {
            const memberships = await WorkspaceMember.find({ user: userId, status: "active" })
                .populate("workspace", "name")
                .lean();

            const workspaces = memberships
                .map((membership) => {
                    const workspace = membership.workspace as unknown as {
                        _id?: unknown;
                        name?: string;
                    } | null;

                    return workspace?._id
                        ? { id: String(workspace._id), name: String(workspace.name ?? "") }
                        : null;
                })
                .filter(Boolean) as { id: string; name: string }[];

            return {
                result: workspaces,
                seen: workspaces.map((workspace) => ({
                    kind: "workspace" as const,
                    id: workspace.id,
                    name: workspace.name
                }))
            };
        }

        case "create_workspace": {
            const name = str(input, "name");
            if (!name) return fail("A name is required");

            const slug = `${name
                .toLowerCase()
                .replace(/[^\w\s-]/g, "")
                .replace(/[\s_-]+/g, "-")
                .replace(/^-+|-+$/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

            const workspace = await Workspace.create({ name, slug, owner: userId });

            // The creator has to be a member, or they cannot open what they made.
            await WorkspaceMember.create({
                workspace: workspace._id,
                user: userId,
                role: "owner"
            });

            return {
                result: { id: String(workspace._id), name: workspace.name },
                applied: {
                    tool: name,
                    kind: "workspace",
                    id: String(workspace._id),
                    name: workspace.name,
                    workspaceId: String(workspace._id)
                }
            };
        }

        case "list_modules": {
            const workspaceId = str(input, "workspaceId");
            const denied = await requireWorkspace(userId, workspaceId);
            if (denied) return fail(denied);

            const membership = await getMembership(workspaceId, userId);

            const modules = await Module.find({
                workspace: oid(workspaceId),
                isArchived: false
            })
                .select("name visibility color")
                .lean();

            // Module access still applies inside a chat.
            const visible: { id: string; name: string; color?: string }[] = [];
            for (const moduleItem of modules) {
                const decision = await resolveModuleAccess(userId, String(moduleItem._id));
                if (decision.allowed) {
                    visible.push({
                        id: String(moduleItem._id),
                        name: moduleItem.name,
                        color: moduleItem.color
                    });
                }
            }

            return {
                // The model gets ids and names only — the colour is for the panel.
                result: {
                    role: membership?.role,
                    modules: visible.map(({ id, name }) => ({ id, name }))
                },
                seen: visible.map((moduleItem) => ({
                    kind: "module" as const,
                    id: moduleItem.id,
                    name: moduleItem.name,
                    color: moduleItem.color
                }))
            };
        }

        case "create_module": {
            const workspaceId = str(input, "workspaceId");
            const moduleName = str(input, "name");

            const denied = await requireWorkspace(userId, workspaceId);
            if (denied) return fail(denied);
            if (!moduleName) return fail("A name is required");

            const visibility =
                str(input, "visibility") === "private" ? "private" : "workspace";

            const moduleItem = await Module.create({
                workspace: oid(workspaceId),
                name: moduleName,
                visibility,
                createdBy: oid(userId)
            });

            await touchWorkspace(workspaceId);

            await logActivity({
                workspace: workspaceId,
                user: userId,
                action: "module_created",
                module: moduleItem._id,
                targetName: moduleItem.name,
                after: moduleItem.name,
                message: `created module "${moduleItem.name}" via Aquiline`
            });

            return {
                result: { id: String(moduleItem._id), name: moduleItem.name },
                applied: {
                    tool: name,
                    kind: "module",
                    id: String(moduleItem._id),
                    name: moduleItem.name,
                    color: moduleItem.color,
                    workspaceId,
                    moduleId: String(moduleItem._id)
                }
            };
        }

        case "list_collections": {
            const moduleId = str(input, "moduleId");
            const denied = await requireBoard(userId, moduleId);
            if (denied) return fail(denied);

            const collections = await Collection.find({ module: oid(moduleId) })
                .sort({ position: 1 })
                .select("name color")
                .lean();

            return {
                result: collections.map((collection) => ({
                    id: String(collection._id),
                    name: collection.name
                })),
                seen: collections.map((collection) => ({
                    kind: "collection" as const,
                    id: String(collection._id),
                    name: collection.name,
                    color: collection.color
                }))
            };
        }

        case "create_collection": {
            const moduleId = str(input, "moduleId");
            const collectionName = str(input, "name");

            const denied = await requireBoard(userId, moduleId);
            if (denied) return fail(denied);
            if (!collectionName) return fail("A name is required");

            const moduleItem = await Module.findById(moduleId).select("workspace");
            if (!moduleItem) return fail("Module not found");

            // Appended, not stacked at position 0 — see the board ordering note.
            const count = await Collection.countDocuments({ module: oid(moduleId) });

            const collection = await Collection.create({
                module: oid(moduleId),
                name: collectionName,
                position: count,
                createdBy: oid(userId)
            });

            await touchWorkspace(moduleItem.workspace);

            await logActivity({
                workspace: moduleItem.workspace,
                user: userId,
                action: "collection_created",
                module: moduleId,
                collectionName: collection._id,
                targetName: collection.name,
                after: collection.name,
                message: `created collection "${collection.name}" via Aquiline`
            });

            return {
                result: { id: String(collection._id), name: collection.name },
                applied: {
                    tool: name,
                    kind: "collection",
                    id: String(collection._id),
                    name: collection.name,
                    color: collection.color,
                    workspaceId: String(moduleItem.workspace),
                    moduleId
                }
            };
        }

        case "list_columns": {
            const moduleId = str(input, "moduleId");
            const denied = await requireBoard(userId, moduleId);
            if (denied) return fail(denied);

            // The agent works on the board; sub-record columns are a separate grid.
            const columns = await Column.find({
                module: oid(moduleId),
                scope: { $ne: "subrecord" }
            })
                .sort({ position: 1 })
                .select("name type statusOptions")
                .lean();

            return {
                result: columns.map((column) => ({
                    id: String(column._id),
                    name: column.name,
                    type: column.type,
                    labels: (column.statusOptions ?? []).map(
                        (option: { label?: string }) => option.label
                    )
                })),
                seen: columns.map((column) => ({
                    kind: "column" as const,
                    id: String(column._id),
                    name: column.name
                }))
            };
        }

        case "create_column": {
            const moduleId = str(input, "moduleId");
            const columnName = str(input, "name");
            const type = asColumnType(str(input, "type"));

            const denied = await requireBoard(userId, moduleId);
            if (denied) return fail(denied);
            if (!columnName) return fail("A name is required");

            const moduleItem = await Module.findById(moduleId).select("workspace");
            if (!moduleItem) return fail("Module not found");

            const labels = Array.isArray(input.labels)
                ? (input.labels as unknown[]).map(String).filter(Boolean)
                : [];

            const statusOptions =
                type === "status" && labels.length > 0
                    ? labels.map((label, index) => ({
                        label,
                        color: STATUS_COLOURS[index % STATUS_COLOURS.length]
                    }))
                    : undefined;

            const count = await Column.countDocuments({
                module: oid(moduleId),
                scope: { $ne: "subrecord" }
            });

            const column = await Column.create({
                module: oid(moduleId),
                name: columnName,
                type,
                statusOptions,
                position: count,
                createdBy: oid(userId)
            });

            await touchWorkspace(moduleItem.workspace);

            await logActivity({
                workspace: moduleItem.workspace,
                user: userId,
                action: "column_created",
                module: moduleId,
                column: column._id,
                targetName: column.name,
                after: column.name,
                message: `added ${type} column "${column.name}" via Aquiline`
            });

            return {
                result: { id: String(column._id), name: column.name, type },
                applied: {
                    tool: name,
                    kind: "column",
                    id: String(column._id),
                    name: column.name,
                    workspaceId: String(moduleItem.workspace),
                    moduleId
                }
            };
        }

        case "list_records": {
            const collectionId = str(input, "collectionId");

            const collection = await Collection.findById(collectionId).select("module");
            if (!collection) return fail("Collection not found");

            const denied = await requireBoard(userId, String(collection.module));
            if (denied) return fail(denied);

            const records = await Record.find({
                collectionName: oid(collectionId),
                isArchived: false,
                parentRecord: null
            })
                .sort({ position: 1 })
                .limit(25)
                .select("name")
                .lean();

            return {
                result: records.map((record) => ({
                    id: String(record._id),
                    name: record.name
                })),
                seen: records.map((record) => ({
                    kind: "record" as const,
                    id: String(record._id),
                    name: record.name
                }))
            };
        }

        case "create_record": {
            const collectionId = str(input, "collectionId");

            const names = Array.isArray(input.names)
                ? (input.names as unknown[]).map((value) => String(value).trim()).filter(Boolean)
                : [];

            if (names.length === 0) return fail("At least one name is required");

            const collection = await Collection.findById(collectionId).select("module");
            if (!collection) return fail("Collection not found");

            const denied = await requireBoard(userId, String(collection.module));
            if (denied) return fail(denied);

            const moduleItem = await Module.findById(collection.module).select("workspace");
            if (!moduleItem) return fail("Module not found");

            const last = await Record.findOne({ collectionName: oid(collectionId), parentRecord: null })
                .sort({ position: -1 })
                .select("position");

            let position = last ? last.position + 1 : 0;
            const created: { id: string; name: string }[] = [];

            for (const recordName of names.slice(0, 20)) {
                const record = await Record.create({
                    workspace: moduleItem.workspace,
                    module: collection.module,
                    collectionName: oid(collectionId),
                    name: recordName,
                    position: position++,
                    createdBy: oid(userId)
                });

                created.push({ id: String(record._id), name: record.name });

                await logActivity({
                    workspace: moduleItem.workspace,
                    user: userId,
                    action: "record_created",
                    module: collection.module,
                    collectionName: collectionId,
                    record: record._id,
                    targetName: record.name,
                    after: record.name,
                    message: `created record "${record.name}" via Aquiline`
                });

                // Same event the REST route emits, so recipes fire either way.
                void runAutomations({
                    type: "record_created",
                    workspace: moduleItem.workspace,
                    module: collection.module,
                    record: record._id,
                    user: userId,
                    collectionName: collectionId
                });
            }

            await touchWorkspace(moduleItem.workspace);

            return {
                result: created,
                applied: {
                    tool: name,
                    kind: "record",
                    id: created[0]?.id ?? "",
                    name:
                        created.length === 1
                            ? created[0].name
                            : `${created.length} records`,
                    workspaceId: String(moduleItem.workspace),
                    moduleId: String(collection.module)
                }
            };
        }

        case "set_cell": {
            const recordId = str(input, "recordId");
            const columnId = str(input, "columnId");
            const value = String(input.value ?? "");

            const record = await Record.findById(recordId).select(
                "workspace module collectionName name"
            );
            if (!record) return fail("Record not found");

            const denied = await requireBoard(userId, String(record.module));
            if (denied) return fail(denied);

            const existing = await RecordValue.findOne({
                record: oid(recordId),
                column: oid(columnId)
            });

            const before = existing?.value ?? null;

            if (existing) {
                existing.value = value;
                await existing.save();
            } else {
                await RecordValue.create({
                    workspace: record.workspace,
                    module: record.module,
                    collectionName: record.collectionName,
                    record: record._id,
                    column: oid(columnId),
                    value,
                    createdBy: oid(userId)
                });
            }

            await touchWorkspace(record.workspace);

            await logActivity({
                workspace: record.workspace,
                user: userId,
                action: "cell_updated",
                module: record.module,
                record: record._id,
                column: columnId,
                before,
                after: value,
                message: `set a field on "${record.name}" via Aquiline`
            });

            void runAutomations({
                type: "column_changed",
                workspace: record.workspace,
                module: record.module,
                record: record._id,
                user: userId,
                column: columnId,
                before,
                after: value
            });

            if (String(before ?? "") !== value) {
                void runAutomations({
                    type: "column_changed_to",
                    workspace: record.workspace,
                    module: record.module,
                    record: record._id,
                    user: userId,
                    column: columnId,
                    before,
                    after: value
                });
            }

            return {
                result: { ok: true },
                applied: {
                    tool: name,
                    kind: "value",
                    id: String(record._id),
                    name: record.name,
                    workspaceId: String(record.workspace),
                    moduleId: String(record.module)
                }
            };
        }

        /**
         * Posting an amendment is NOT gated behind an authorise press.
         * It is an everyday write like set_cell, it destroys nothing, and the
         * user can delete it in one click from the panel — gating it would
         * make the agent tedious rather than safe. It is attributed to the
         * calling user, exactly as it would be if they had typed it themselves.
         */
        case "post_amendment": {
            const message = String(input.message ?? "").trim();

            if (!message) return fail("An amendment cannot be empty");

            // Accepts a NAME as well as an id: history reaches the model as
            // plain text, so by a follow-up turn the id it was handed is gone.
            const recordId = await resolveTargetId(
                "record",
                str(input, "recordId"),
                context
            );

            if (!recordId) return fail("Record not found");

            const record = await Record.findById(recordId).select(
                "workspace module collectionName name"
            );
            if (!record) return fail("Record not found");

            const denied = await requireBoard(userId, String(record.module));
            if (denied) return fail(denied);

            const amendment = await Comment.create({
                workspace: record.workspace,
                module: record.module,
                record: record._id,
                user: oid(userId),
                message
            });

            await touchWorkspace(record.workspace);

            await logActivity({
                workspace: record.workspace,
                user: userId,
                action: "comment_added",
                module: record.module,
                collectionName: record.collectionName,
                record: record._id,
                targetName: record.name,
                after: message,
                message: `posted an amendment on "${record.name}" via Aquiline`
            });

            // No runAutomations: no trigger reads "an amendment was posted".

            return {
                result: { ok: true, id: String(amendment._id) },
                applied: {
                    tool: name,
                    kind: "amendment",
                    // The chip names the RECORD, because that is what the
                    // amendment is about and what the reply sentence will say.
                    id: String(record._id),
                    name: record.name,
                    workspaceId: String(record.workspace),
                    moduleId: String(record.module)
                }
            };
        }

        case "create_blueprint": {
            // Only ever reached with options.authorised — the gate above owns
            // the unauthorised path.
            const plan =
                (input.plan as BlueprintPlan | undefined) ??
                parseBlueprint(input, context.workspaceId);

            if (!plan) return fail("Nothing to build");

            const built = await buildBlueprint(plan, userId);

            return {
                result: {
                    created: built.applied.length,
                    workspaceId: built.workspaceId
                },
                appliedMany: built.applied
            };
        }

        case "update_entity": {
            const kind = str(input, "kind");
            const targetId = await resolveTargetId(kind, str(input, "id"), context);

            if (!targetId) {
                return fail(
                    `Could not find a ${kind} called "${str(input, "id")}" here \u2014 open the right module, or give its exact name.`
                );
            }

            const nextName = str(input, "name");
            const color = str(input, "color");
            const visibility = str(input, "visibility");
            const description = str(input, "description");
            const collection = str(input, "collection");

            if (!nextName && !color && !visibility && !description && !collection) {
                return fail("Say what to change \u2014 a new name, colour, visibility or collection.");
            }

            switch (kind) {

                case "workspace": {
                    const membership = await getMembership(targetId, userId);

                    if (!isWorkspaceManager(membership?.role)) {
                        return fail("Only an owner or admin can rename a workspace");
                    }

                    const workspace = await Workspace.findById(targetId);
                    if (!workspace) return fail("Workspace not found");

                    const before = workspace.name;

                    if (nextName) workspace.name = nextName;
                    if (description) workspace.description = description;

                    await workspace.save();

                    await logActivity({
                        workspace: workspace._id,
                        user: userId,
                        action: "workspace_updated",
                        targetName: workspace.name,
                        before,
                        after: workspace.name,
                        message: `renamed workspace "${before}" to "${workspace.name}" via Aquiline`
                    });

                    return {
                        result: { id: targetId, name: workspace.name },
                        applied: {
                            tool: name,
                            kind: "workspace",
                            id: targetId,
                            name: workspace.name,
                            workspaceId: targetId
                        }
                    };
                }

                case "module": {
                    const denied = await requireBoard(userId, targetId);
                    if (denied) return fail(denied);

                    const moduleItem = await Module.findById(targetId);
                    if (!moduleItem) return fail("Module not found");

                    // Visibility decides who can open the module, so it carries
                    // the same owner/admin rule as the REST route.
                    if (visibility) {
                        const membership = await getMembership(
                            String(moduleItem.workspace),
                            userId
                        );

                        if (!isWorkspaceManager(membership?.role)) {
                            return fail("Only an owner or admin can change who can see a module");
                        }

                        moduleItem.visibility = visibility as "workspace" | "private";
                    }

                    const before = moduleItem.name;

                    if (nextName) moduleItem.name = nextName;
                    if (description) moduleItem.description = description;
                    if (color) moduleItem.color = color;

                    await moduleItem.save();
                    await touchWorkspace(moduleItem.workspace);

                    await logActivity({
                        workspace: moduleItem.workspace,
                        user: userId,
                        action: "module_updated",
                        module: moduleItem._id,
                        targetName: moduleItem.name,
                        before,
                        after: moduleItem.name,
                        message: `updated module "${moduleItem.name}" via Aquiline`
                    });

                    return {
                        result: { id: targetId, name: moduleItem.name },
                        applied: {
                            tool: name,
                            kind: "module",
                            id: targetId,
                            name: moduleItem.name,
                            workspaceId: String(moduleItem.workspace),
                            moduleId: targetId
                        }
                    };
                }

                case "collection": {
                    const collection = await Collection.findById(targetId);
                    if (!collection) return fail("Collection not found");

                    const denied = await requireBoard(userId, String(collection.module));
                    if (denied) return fail(denied);

                    const before = collection.name;

                    if (nextName) collection.name = nextName;
                    if (color) collection.color = color;

                    await collection.save();

                    const moduleItem = await Module.findById(collection.module).select(
                        "workspace"
                    );

                    if (moduleItem) {
                        await touchWorkspace(moduleItem.workspace);

                        await logActivity({
                            workspace: moduleItem.workspace,
                            user: userId,
                            action: "collection_updated",
                            module: collection.module,
                            collectionName: collection._id,
                            targetName: collection.name,
                            before,
                            after: collection.name,
                            message: `renamed collection "${before}" to "${collection.name}" via Aquiline`
                        });
                    }

                    return {
                        result: { id: targetId, name: collection.name },
                        applied: {
                            tool: name,
                            kind: "collection",
                            id: targetId,
                            name: collection.name,
                            color: collection.color,
                            workspaceId: moduleItem ? String(moduleItem.workspace) : undefined,
                            moduleId: String(collection.module)
                        }
                    };
                }

                case "column": {
                    const column = await Column.findById(targetId);
                    if (!column) return fail("Column not found");

                    const denied = await requireBoard(userId, String(column.module));
                    if (denied) return fail(denied);

                    const before = column.name;

                    // A column carries no colour of its own — the status
                    // labels do — so only the name is editable here.
                    if (nextName) column.name = nextName;

                    await column.save();

                    const moduleItem = await Module.findById(column.module).select("workspace");

                    if (moduleItem) {
                        await touchWorkspace(moduleItem.workspace);

                        await logActivity({
                            workspace: moduleItem.workspace,
                            user: userId,
                            action: "column_updated",
                            module: column.module,
                            column: column._id,
                            targetName: column.name,
                            before,
                            after: column.name,
                            message: `renamed column "${before}" to "${column.name}" via Aquiline`
                        });
                    }

                    return {
                        result: { id: targetId, name: column.name },
                        applied: {
                            tool: name,
                            kind: "column",
                            id: targetId,
                            name: column.name,
                            workspaceId: moduleItem ? String(moduleItem.workspace) : undefined,
                            moduleId: String(column.module)
                        }
                    };
                }

                case "record": {
                    const record = await Record.findById(targetId);
                    if (!record) return fail("Record not found");

                    const denied = await requireBoard(userId, String(record.module));
                    if (denied) return fail(denied);

                    const before = record.name;
                    let moved = false;

                    if (nextName) record.name = nextName;

                    // Moving beats deleting and recreating: the record values come along.
                    if (collection) {
                        const collectionId = await resolveTargetId("collection", collection, {
                            ...context,
                            moduleId: String(record.module)
                        });

                        if (!collectionId) return fail(`No collection called "${collection}" in this module`);

                        const last = await Record.findOne({ collectionName: oid(collectionId), parentRecord: null })
                            .sort({ position: -1 })
                            .select("position");

                        record.collectionName = oid(collectionId);
                        record.position = last ? last.position + 1 : 0;
                        moved = true;
                    }

                    await record.save();
                    await touchWorkspace(record.workspace);

                    await logActivity({
                        workspace: record.workspace,
                        user: userId,
                        action: moved ? "record_moved" : "record_updated",
                        module: record.module,
                        collectionName: record.collectionName,
                        record: record._id,
                        targetName: record.name,
                        before,
                        after: record.name,
                        message: moved
                            ? `moved "${record.name}" to another collection via Aquiline`
                            : `renamed record "${before}" to "${record.name}" via Aquiline`
                    });

                    if (moved) {
                        void runAutomations({
                            type: "record_moved",
                            workspace: record.workspace,
                            module: record.module,
                            record: record._id,
                            user: userId,
                            collectionName: record.collectionName
                        });
                    }

                    return {
                        result: { id: targetId, name: record.name, moved },
                        applied: {
                            tool: name,
                            kind: "record",
                            id: targetId,
                            name: record.name,
                            workspaceId: String(record.workspace),
                            moduleId: String(record.module)
                        }
                    };
                }

                default:
                    return fail("Unknown kind");
            }
        }

        case "delete_entity": {
            const kind = str(input, "kind");
            const wanted = targetsOf(input);

            if (wanted.length === 0) return fail("Say what to delete");

            /**
             * A batch runs one at a time through the SAME single-item path, so
             * every permission check still applies to every row. One bad target
             * is reported, not fatal — deleting four of five and saying so beats
             * refusing the lot.
             */
            if (wanted.length > 1) {
                const removed: AppliedAction[] = [];
                const failures: string[] = [];

                for (const target of wanted) {
                    const outcome = await executeTool(
                        "delete_entity",
                        { kind, id: target },
                        context,
                        { authorised: true }
                    );

                    const error = (outcome.result as { error?: string })?.error;

                    if (error) {
                        failures.push(`${target}: ${error}`);
                    } else if (outcome.applied) {
                        removed.push(outcome.applied);
                    }
                }

                return {
                    result: {
                        deleted: removed.map((action) => action.name),
                        failed: failures
                    },
                    appliedMany: removed
                };
            }

            const id = wanted[0];

            const targetId = await resolveTargetId(kind, id, context);

            if (!targetId) {
                return fail(
                    `Could not find a ${kind} called "${id}" here — open the right module, or give its exact name.`
                );
            }

            switch (kind) {
                case "workspace": {
                    const membership = await getMembership(targetId, userId);
                    if (membership?.role !== "owner") {
                        return fail("Only the workspace owner can delete it");
                    }

                    const workspace = await Workspace.findById(targetId).select("name");
                    if (!workspace) return fail("Workspace not found");

                    await Workspace.deleteOne({ _id: oid(targetId) });
                    await WorkspaceMember.deleteMany({ workspace: oid(targetId) });

                    return {
                        result: { deleted: workspace.name },
                        applied: {
                            tool: name,
                            kind: "workspace",
                            id: targetId,
                            name: workspace.name,
                            workspaceId: targetId
                        }
                    };
                }

                case "module": {
                    const decision = await resolveModuleAccess(userId, targetId);
                    if (!decision.allowed) return fail(decision.message);

                    const membership = await getMembership(
                        String(decision.workspaceId),
                        userId
                    );

                    if (!isWorkspaceManager(membership?.role)) {
                        return fail("Only an owner or admin can delete a module");
                    }

                    const moduleItem = await Module.findById(targetId).select("name workspace");
                    if (!moduleItem) return fail("Module not found");

                    await Module.deleteOne({ _id: oid(targetId) });
                    await touchWorkspace(moduleItem.workspace);

                    await logActivity({
                        workspace: moduleItem.workspace,
                        user: userId,
                        action: "module_deleted",
                        targetName: moduleItem.name,
                        before: moduleItem.name,
                        after: null,
                        message: `deleted module "${moduleItem.name}" via Aquiline`
                    });

                    return {
                        result: { deleted: moduleItem.name },
                        applied: {
                            tool: name,
                            kind: "module",
                            id: targetId,
                            name: moduleItem.name,
                            workspaceId: String(moduleItem.workspace)
                        }
                    };
                }

                case "collection":
                case "record":
                case "column": {
                    // Branched rather than picking a model out of a union —
                    // mongoose's generics make the union uncallable.
                    const document =
                        kind === "collection"
                            ? await Collection.findById(targetId).select("name module").lean()
                            : kind === "record"
                                ? await Record.findById(targetId).select("name module").lean()
                                : await Column.findById(targetId).select("name module").lean();

                    if (!document) return fail(`${kind} not found`);

                    const moduleId = String(document.module);

                    const denied = await requireBoard(userId, moduleId);
                    if (denied) return fail(denied);

                    const moduleItem = await Module.findById(moduleId).select("workspace");

                    if (kind === "collection") {
                        await Collection.deleteOne({ _id: oid(targetId) });
                    } else if (kind === "record") {
                        await Record.deleteOne({ _id: oid(targetId) });
                    } else {
                        await Column.deleteOne({ _id: oid(targetId) });
                    }

                    if (moduleItem) {
                        await touchWorkspace(moduleItem.workspace);

                        await logActivity({
                            workspace: moduleItem.workspace,
                            user: userId,
                            action:
                                kind === "collection"
                                    ? "collection_deleted"
                                    : kind === "record"
                                        ? "record_deleted"
                                        : "column_deleted",
                            module: moduleId,
                            targetName: document.name,
                            before: document.name,
                            after: null,
                            message: `deleted ${kind} "${document.name}" via Aquiline`
                        });
                    }

                    return {
                        result: { deleted: document.name },
                        applied: {
                            tool: name,
                            kind: kind as AppliedAction["kind"],
                            id: targetId,
                            name: document.name ?? kind,
                            workspaceId: moduleItem ? String(moduleItem.workspace) : undefined,
                            moduleId
                        }
                    };
                }

                default:
                    return fail("Unknown kind");
            }
        }

        default:
            return fail(`Unknown tool: ${name}`);
    }
}
