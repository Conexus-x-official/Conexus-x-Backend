import { Response } from "express";
import mongoose from "mongoose";

import { ModuleAccessRequest } from "../middleware/access.middleware";
import { isWorkspaceManager } from "../services/access.service";
import Form, { newPublicId, PUBLIC_FORM_FIELD_TYPES, FORM_THEMES } from "../models/Form";
import Column from "../models/Column";
import Collection from "../models/Collection";
import Module from "../models/Module";
import { touchModule, touchWorkspace } from "../utils/workspaceHelper";

/**
 * The AUTHENTICATED side of public forms — the builder reads and writes here.
 * Every route is behind requireModuleAccess(moduleFrom.param); config writes
 * additionally require owner|admin, because publishing a module to the internet
 * is a structural decision, not an everyday edit.
 *
 * The PUBLIC side (GET schema + POST submit) is controllers/publicForm.controller.ts,
 * mounted with no `protect`.
 */

const PUBLIC_TYPES = new Set<string>(PUBLIC_FORM_FIELD_TYPES);

const clampStr = (v: unknown, max: number, fallback = "") =>
  typeof v === "string" ? v.trim().slice(0, max) : fallback;

// GET /api/forms/:moduleId — the module's form, or null if none yet.
export const getForm = async (req: ModuleAccessRequest, res: Response) => {
  try {
    const { moduleId } = req.params;
    const form = await Form.findOne({ module: moduleId });
    return res.status(200).json({ form: form ?? null });
  } catch (error: any) {
    console.error("getForm:", error?.message);
    return res.status(500).json({ message: "Could not load the form." });
  }
};

// PUT /api/forms/:moduleId — create or update the config. Owner/admin only.
export const upsertForm = async (req: ModuleAccessRequest, res: Response) => {
  try {
    if (!isWorkspaceManager(req.moduleAccess?.role as any)) {
      return res
        .status(403)
        .json({ message: "Only an owner or admin can configure a public form." });
    }

    const { moduleId } = req.params;
    const moduleItem = await Module.findById(moduleId).select("workspace");
    if (!moduleItem) return res.status(404).json({ message: "Module not found" });

    const body = req.body ?? {};

    // Collection must belong to this module.
    let collectionId = body.targetCollection;
    if (collectionId) {
      const coll = await Collection.findById(collectionId).select("module");
      if (!coll || String(coll.module) !== String(moduleId)) {
        return res.status(400).json({ message: "That collection is not on this module." });
      }
    } else {
      const first = await Collection.findOne({ module: moduleId }).sort({ position: 1 });
      if (!first)
        return res.status(400).json({ message: "Add a collection before publishing a form." });
      collectionId = first._id;
    }

    // Keep only fields that name a real, public-safe column on this module.
    const columns = await Column.find({
      module: moduleId,
      scope: { $ne: "subrecord" },
    }).select("_id type");
    const columnById = new Map(columns.map((c) => [String(c._id), c]));

    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const fields = rawFields
      .filter((f: any) => {
        const col = columnById.get(String(f?.column));
        return col && PUBLIC_TYPES.has(col.type ?? "text");
      })
      .map((f: any, i: number) => ({
        column: new mongoose.Types.ObjectId(String(f.column)),
        label: clampStr(f.label, 120),
        required: Boolean(f.required),
        position: i,
      }));

    const theme = FORM_THEMES.includes(body.theme) ? body.theme : "minimal";

    const update: Record<string, unknown> = {
      workspace: moduleItem.workspace,
      module: moduleId,
      targetCollection: collectionId,
      fields,
      theme,
      isPublished: Boolean(body.isPublished),
      showSignupCta: body.showSignupCta === undefined ? true : Boolean(body.showSignupCta),
    };
    if (body.title !== undefined) update.title = clampStr(body.title, 160, "Untitled form");
    if (body.description !== undefined) update.description = clampStr(body.description, 2000);
    if (body.submitLabel !== undefined) update.submitLabel = clampStr(body.submitLabel, 40, "Submit");
    if (body.successTitle !== undefined) update.successTitle = clampStr(body.successTitle, 160, "Thank you!");
    if (body.successBody !== undefined) update.successBody = clampStr(body.successBody, 2000);

    const form = await Form.findOneAndUpdate(
      { module: moduleId },
      {
        $set: update,
        $setOnInsert: {
          publicId: newPublicId(typeof body.title === "string" ? body.title : ""),
          createdBy: req.user?.id,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    await touchWorkspace(moduleItem.workspace);
    await touchModule(String(moduleId));

    return res.status(200).json({ form });
  } catch (error: any) {
    console.error("upsertForm:", error?.message);
    return res.status(500).json({ message: "Could not save the form." });
  }
};

// POST /api/forms/:moduleId/reset-link — new publicId, invalidating the old URL.
export const resetFormLink = async (req: ModuleAccessRequest, res: Response) => {
  try {
    if (!isWorkspaceManager(req.moduleAccess?.role as any)) {
      return res.status(403).json({ message: "Only an owner or admin can reset the link." });
    }

    const existing = await Form.findOne({ module: req.params.moduleId });
    if (!existing) return res.status(404).json({ message: "No form to reset." });

    existing.publicId = newPublicId(existing.title);
    await existing.save();

    return res.status(200).json({ form: existing });
  } catch (error: any) {
    console.error("resetFormLink:", error?.message);
    return res.status(500).json({ message: "Could not reset the link." });
  }
};
