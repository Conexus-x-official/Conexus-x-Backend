/**
 * End-to-end probe of the public form feature, against a throwaway fixture.
 *
 * Goes through the CONTROLLERS (not raw model writes) so the honeypot, the
 * per-type validation and the record-creation path are all exercised the way a
 * real submit would hit them. Everything is created under one workspace and
 * deleted at the end — including from the catch, so a mid-probe crash does not
 * litter the database (the lesson the Meet probes learned).
 */

import mongoose from "mongoose";
import type { Response } from "express";
import env from "../config/env.js";

import Workspace from "../models/Workspace";
import WorkspaceMember from "../models/WorkspaceMember";
import Module from "../models/Module";
import Collection from "../models/Collection";
import Column from "../models/Column";
import RecordModel from "../models/Record";
import RecordValue from "../models/RecordValue";
import Activity from "../models/Activity";
import Form from "../models/Form";
import User from "../models/User";

import { upsertForm } from "../controllers/form.controller";
import { getPublicForm, submitPublicForm } from "../controllers/publicForm.controller";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        failures.push(name + (detail ? ` — ${detail}` : ""));
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
};

/** A minimal Response double that records status + json body. */
function mockRes() {
    const r: any = {};
    r.statusCode = 200;
    r.body = undefined;
    r.status = (c: number) => {
        r.statusCode = c;
        return r;
    };
    r.json = (b: unknown) => {
        r.body = b;
        return r;
    };
    r.set = () => r;
    return r as Response & { statusCode: number; body: any };
}

async function main() {
    await mongoose.connect(env.mongo_url as string);
    console.log("connected\n");

    const owner = await User.create({
        firstName: "PF",
        lastName: "Owner",
        email: `pf-${Date.now()}@probe.test`,
        authProvider: "google",
        googleId: `pf-${Date.now()}`,
    });
    const ws = await Workspace.create({
        name: "PF Probe",
        slug: `pf-probe-${Date.now()}`,
        owner: owner._id,
    });
    const teardown = async () => {
        const mods = await Module.find({ workspace: ws._id }).select("_id");
        const modIds = mods.map((m) => m._id);
        await Promise.all([
            Workspace.deleteOne({ _id: ws._id }),
            WorkspaceMember.deleteMany({ workspace: ws._id }),
            Module.deleteMany({ workspace: ws._id }),
            Collection.deleteMany({ module: { $in: modIds } }),
            Column.deleteMany({ module: { $in: modIds } }),
            RecordModel.deleteMany({ workspace: ws._id }),
            RecordValue.deleteMany({ workspace: ws._id }),
            Activity.deleteMany({ workspace: ws._id }),
            Form.deleteMany({ workspace: ws._id }),
            User.deleteOne({ _id: owner._id }),
        ]);
    };

    try {
        await WorkspaceMember.create({
            workspace: ws._id,
            user: owner._id,
            role: "owner",
            status: "active",
        });

        const mod = await Module.create({
            workspace: ws._id,
            name: "Leads",
            createdBy: owner._id,
        });
        const coll = await Collection.create({
            module: mod._id,
            name: "Inbox",
            createdBy: owner._id,
        });

        const emailCol = await Column.create({
            module: mod._id,
            name: "Email",
            type: "email",
            createdBy: owner._id,
        });
        const numCol = await Column.create({
            module: mod._id,
            name: "Budget",
            type: "number",
            createdBy: owner._id,
        });
        const statusCol = await Column.create({
            module: mod._id,
            name: "Interest",
            type: "status",
            statusOptions: [
                { label: "Hot", color: "#ef4444" },
                { label: "Cold", color: "#3b82f6" },
            ],
            createdBy: owner._id,
        });
        const personCol = await Column.create({
            module: mod._id,
            name: "Owner",
            type: "person",
            createdBy: owner._id,
        });

        // ── build + publish the form via the controller ──────────────────
        const buildReq: any = {
            params: { moduleId: String(mod._id) },
            user: { id: String(owner._id) },
            moduleAccess: { role: "owner" },
            body: {
                title: "Contact us",
                targetCollection: String(coll._id),
                isPublished: true,
                fields: [
                    { column: String(emailCol._id), label: "Your email", required: true },
                    { column: String(numCol._id), label: "", required: false },
                    { column: String(statusCol._id), label: "", required: false },
                    // person column must be dropped — not public-safe
                    { column: String(personCol._id), label: "", required: false },
                ],
            },
        };
        let res = mockRes();
        await upsertForm(buildReq, res);
        check("upsertForm returns 200", res.statusCode === 200, `got ${res.statusCode}`);
        const form = res.body?.form;
        check("form has a publicId", typeof form?.publicId === "string" && form.publicId.length >= 8);
        check("person column was filtered out", form?.fields?.length === 3, `kept ${form?.fields?.length}`);
        check("field label override kept", form?.fields?.[0]?.label === "Your email");

        // ── public GET ──────────────────────────────────────────────────
        res = mockRes();
        await getPublicForm({ params: { publicId: form.publicId } } as any, res);
        check("public GET returns 200", res.statusCode === 200, `got ${res.statusCode}`);
        check("public GET lists 3 fields", res.body?.form?.fields?.length === 3);
        check(
            "public GET leaks no internal ids",
            !JSON.stringify(res.body).includes(String(ws._id)) &&
                !JSON.stringify(res.body).includes(String(mod._id))
        );

        res = mockRes();
        await getPublicForm({ params: { publicId: "does-not-exist" } } as any, res);
        check("unknown publicId → 404", res.statusCode === 404, `got ${res.statusCode}`);

        // ── submit: honeypot ────────────────────────────────────────────
        res = mockRes();
        await submitPublicForm(
            {
                params: { publicId: form.publicId },
                body: { name: "Bot", website_url: "http://spam", values: {} },
            } as any,
            res
        );
        check("honeypot → 200 and no record", res.statusCode === 200);
        check("honeypot wrote nothing", (await RecordModel.countDocuments({ module: mod._id })) === 0);

        // ── submit: type mismatch ──────────────────────────────────────
        res = mockRes();
        await submitPublicForm(
            {
                params: { publicId: form.publicId },
                body: {
                    name: "Ada",
                    values: { [String(emailCol._id)]: "not-an-email" },
                },
            } as any,
            res
        );
        check("bad email → 400", res.statusCode === 400, `got ${res.statusCode} ${JSON.stringify(res.body)}`);

        res = mockRes();
        await submitPublicForm(
            {
                params: { publicId: form.publicId },
                body: {
                    name: "Ada",
                    values: { [String(emailCol._id)]: "ada@x.com", [String(numCol._id)]: "abc" },
                },
            } as any,
            res
        );
        check("bad number → 400", res.statusCode === 400, `got ${res.statusCode}`);

        res = mockRes();
        await submitPublicForm(
            {
                params: { publicId: form.publicId },
                body: {
                    name: "Ada",
                    values: { [String(emailCol._id)]: "ada@x.com", [String(statusCol._id)]: "Warm" },
                },
            } as any,
            res
        );
        check("status not in options → 400", res.statusCode === 400, `got ${res.statusCode}`);

        // ── submit: missing required ───────────────────────────────────
        res = mockRes();
        await submitPublicForm(
            { params: { publicId: form.publicId }, body: { name: "Ada", values: {} } } as any,
            res
        );
        check("missing required email → 400", res.statusCode === 400, `got ${res.statusCode}`);

        // ── submit: the happy path ─────────────────────────────────────
        res = mockRes();
        await submitPublicForm(
            {
                params: { publicId: form.publicId },
                body: {
                    name: "Ada Lovelace",
                    values: {
                        [String(emailCol._id)]: "ada@x.com",
                        [String(numCol._id)]: "5000",
                        [String(statusCol._id)]: "Hot",
                    },
                },
            } as any,
            res
        );
        check("valid submit → 201", res.statusCode === 201, `got ${res.statusCode} ${JSON.stringify(res.body)}`);

        const record = await RecordModel.findOne({ module: mod._id, name: "Ada Lovelace" });
        check("record was created in the target collection", String(record?.collectionName) === String(coll._id));
        check("record createdBy is the form owner", String(record?.createdBy) === String(owner._id));

        const vals = await RecordValue.find({ record: record?._id }).lean();
        check("3 record values written", vals.length === 3, `got ${vals.length}`);
        check(
            "number stored as a clean numeric string",
            vals.find((v) => String(v.column) === String(numCol._id))?.value === "5000"
        );

        const freshForm = await Form.findById(form._id);
        check("submissionCount incremented", freshForm?.submissionCount === 1, `got ${freshForm?.submissionCount}`);

        const activity = await Activity.findOne({ record: record?._id, action: "record_created" });
        check("activity row written", !!activity && !!(activity.metadata as any)?.publicForm);

        // ── an unpublished form rejects both ───────────────────────────
        await Form.updateOne({ _id: form._id }, { isPublished: false });
        res = mockRes();
        await getPublicForm({ params: { publicId: form.publicId } } as any, res);
        check("unpublished → GET 404", res.statusCode === 404);
        res = mockRes();
        await submitPublicForm(
            { params: { publicId: form.publicId }, body: { name: "X", values: {} } } as any,
            res
        );
        check("unpublished → submit 404", res.statusCode === 404);
    } finally {
        await teardown();
        await mongoose.disconnect();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) {
        console.log(failures.map((f) => `  - ${f}`).join("\n"));
        process.exit(1);
    }
}

main().catch(async (e) => {
    console.error(e);
    process.exit(1);
});
