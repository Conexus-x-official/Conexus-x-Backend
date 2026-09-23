import { Request, Response } from "express";
import mongoose from "mongoose";

import Form from "../models/Form";
import Column from "../models/Column";
import Record from "../models/Record";
import RecordValue from "../models/RecordValue";
import { validatePublicFormValue } from "../services/formValidation";
import { touchModule, touchWorkspace } from "../utils/workspaceHelper";
import { logActivity } from "../services/activity.service";
import { runAutomations } from "../services/automation.service";
import { emitChange } from "../services/realtime.service";

/**
 * The PUBLIC side of forms — no `protect`, no session. A stranger on the
 * internet hits GET to render the form and POST to submit it.
 *
 * Everything a public write must be paranoid about lives here: the form has to
 * be published, a honeypot field catches the crude bots, a per-IP throttle
 * (routes/publicForm.routes.ts) blunts a script, every value is coerced to its
 * column's type before it becomes a RecordValue, and NOTHING internal is
 * returned — the GET response carries only what a form needs to render.
 */

/** Bots fill every field; this one is invisible to a person. */
const HONEYPOT_FIELD = "website_url";

// GET /api/public/forms/:publicId — the render schema, or 404.
export const getPublicForm = async (req: Request, res: Response) => {
  try {
    const form = await Form.findOne({ publicId: req.params.publicId, isPublished: true });
    if (!form) return res.status(404).json({ message: "This form is not available." });

    const columns = await Column.find({
      _id: { $in: form.fields.map((f) => f.column) },
    }).select("name type statusOptions options");
    const columnById = new Map(columns.map((c) => [String(c._id), c]));

    const fields = form.fields
      .map((f) => {
        const col = columnById.get(String(f.column));
        if (!col) return null;
        return {
          id: String(col._id),
          name: f.label || col.name,
          type: col.type,
          required: f.required,
          options: col.statusOptions?.length
            ? col.statusOptions.map((o) => ({ label: o.label, color: o.color }))
            : (col.options || []).map((label) => ({ label })),
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      form: {
        title: form.title,
        description: form.description,
        submitLabel: form.submitLabel,
        theme: form.theme,
        successTitle: form.successTitle,
        successBody: form.successBody,
        showSignupCta: form.showSignupCta,
        fields,
      },
    });
  } catch (error: any) {
    console.error("getPublicForm:", error?.message);
    return res.status(500).json({ message: "Could not load this form." });
  }
};

// POST /api/public/forms/:publicId/submit
export const submitPublicForm = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};

    // Honeypot: a bot filled the hidden field. Answer 200 so it never learns.
    if (typeof body[HONEYPOT_FIELD] === "string" && body[HONEYPOT_FIELD].trim() !== "") {
      return res.status(200).json({ ok: true });
    }

    const form = await Form.findOne({ publicId: req.params.publicId, isPublished: true });
    if (!form) return res.status(404).json({ message: "This form is not available." });

    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    if (!name) return res.status(400).json({ message: "A name is required." });

    const columns = await Column.find({
      _id: { $in: form.fields.map((f) => f.column) },
    });
    const columnById = new Map(columns.map((c) => [String(c._id), c]));

    const submitted: Record<string, unknown> = body.values && typeof body.values === "object" ? body.values : {};

    // Validate + coerce EVERY field before writing anything.
    const writes: { column: mongoose.Types.ObjectId; value: string }[] = [];
    for (const field of form.fields) {
      const col = columnById.get(String(field.column));
      if (!col) continue;

      const result = validatePublicFormValue(col, submitted[String(field.column)]);
      if (!result.ok) return res.status(400).json({ message: result.error });
      if ("skip" in result) {
        if (field.required)
          return res.status(400).json({ message: `${field.label || col.name} is required.` });
        continue;
      }
      writes.push({ column: col._id as mongoose.Types.ObjectId, value: result.value });
    }

    // File it. createdBy is the form's owner — the closest honest attribution
    // for a row nobody with an account actually typed.
    const last = await Record.findOne({
      collectionName: form.targetCollection,
      parentRecord: null,
    }).sort({ position: -1 });

    const record = await Record.create({
      workspace: form.workspace,
      module: form.module,
      collectionName: form.targetCollection,
      name,
      position: last ? last.position + 1 : 0,
      createdBy: form.createdBy,
    });

    if (writes.length) {
      await RecordValue.insertMany(
        writes.map((w) => ({
          workspace: form.workspace,
          module: form.module,
          collectionName: form.targetCollection,
          record: record._id,
          column: w.column,
          value: w.value,
          createdBy: form.createdBy,
        }))
      );
    }

    await Form.updateOne({ _id: form._id }, { $inc: { submissionCount: 1 } });
    await touchWorkspace(form.workspace);
    await touchModule(form.module);

    await logActivity({
      workspace: form.workspace,
      user: form.createdBy,
      action: "record_created",
      module: form.module,
      collectionName: String(form.targetCollection),
      record: record._id,
      targetName: record.name,
      after: record.name,
      message: `received "${record.name}" from the public form`,
      metadata: { publicForm: true },
    });

    void runAutomations({
      type: "record_created",
      workspace: form.workspace,
      module: form.module,
      record: record._id,
      collectionName: String(form.targetCollection),
      user: String(form.createdBy),
    });

    emitChange({
      entity: "record",
      action: "created",
      id: String(record._id),
      workspaceId: String(form.workspace),
      moduleId: String(form.module),
      collectionId: String(form.targetCollection),
      data: record,
      actorId: String(form.createdBy),
    });

    return res.status(201).json({ ok: true });
  } catch (error: any) {
    console.error("submitPublicForm:", error?.message);
    return res.status(500).json({ message: "Could not submit the form. Please try again." });
  }
};
