import { IColumn } from "../models/Column";

/**
 * Coerce + validate ONE public-form value against its column's type.
 *
 * This is the only thing standing between a stranger's POST body and a
 * RecordValue, so it is strict: a `number` field that gets "abc" is a 400, not
 * a silently-stored string. The return is the STRING that will be written as
 * the RecordValue (the whole store is string-encoded — see the client's record
 * value encodings note), or an error, or `skip` for an empty optional field.
 */

type Result =
  | { ok: true; value: string }
  | { ok: true; skip: true }
  | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 4000;

const isEmpty = (raw: unknown) =>
  raw === undefined ||
  raw === null ||
  (typeof raw === "string" && raw.trim() === "") ||
  (Array.isArray(raw) && raw.length === 0);

const asDateString = (raw: unknown): string | null => {
  const s = String(raw).trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  // Store YYYY-MM-DD (local components of the parsed instant).
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : iso;
};

export function validatePublicFormValue(column: IColumn, raw: unknown): Result {
  const name = column.name || "This field";

  if (isEmpty(raw)) return { ok: true, skip: true };

  switch (column.type) {
    case "text":
    case "phone": {
      const s = String(raw).trim().slice(0, MAX_TEXT);
      return { ok: true, value: s };
    }

    case "link": {
      const s = String(raw).trim().slice(0, MAX_TEXT);
      if (!/^https?:\/\/\S+$/i.test(s))
        return { ok: false, error: `${name} must be a URL starting with http.` };
      return { ok: true, value: s };
    }

    case "email": {
      const s = String(raw).trim().slice(0, 320);
      if (!EMAIL.test(s)) return { ok: false, error: `${name} must be a valid email address.` };
      return { ok: true, value: s };
    }

    case "number": {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a number.` };
      return { ok: true, value: String(n) };
    }

    case "rating": {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n) || n < 0 || n > 5 || (n * 2) % 1 !== 0)
        return { ok: false, error: `${name} must be a rating from 0 to 5 in half steps.` };
      return { ok: true, value: String(n) };
    }

    case "checkbox": {
      const truthy = raw === true || raw === "true" || raw === "on" || raw === 1 || raw === "1";
      return { ok: true, value: truthy ? "true" : "false" };
    }

    case "date": {
      const d = asDateString(raw);
      if (!d) return { ok: false, error: `${name} must be a valid date.` };
      return { ok: true, value: d };
    }

    case "timeline": {
      let span: { startDate?: unknown; endDate?: unknown };
      if (typeof raw === "string") {
        try {
          span = JSON.parse(raw);
        } catch {
          return { ok: false, error: `${name} is not a valid date range.` };
        }
      } else if (raw && typeof raw === "object") {
        span = raw as { startDate?: unknown; endDate?: unknown };
      } else {
        return { ok: false, error: `${name} is not a valid date range.` };
      }

      const start = span.startDate ? asDateString(span.startDate) : "";
      const end = span.endDate ? asDateString(span.endDate) : "";
      if (span.startDate && !start) return { ok: false, error: `${name}: the start date is invalid.` };
      if (span.endDate && !end) return { ok: false, error: `${name}: the end date is invalid.` };
      if (start && end && end < start)
        return { ok: false, error: `${name}: the end date is before the start date.` };
      if (!start && !end) return { ok: true, skip: true };
      return { ok: true, value: JSON.stringify({ startDate: start, endDate: end }) };
    }

    case "status":
    case "dropdown": {
      const s = String(raw).trim();
      const allowed = (column.statusOptions?.length
        ? column.statusOptions.map((o) => o.label)
        : column.options || []) as string[];
      if (allowed.length && !allowed.includes(s))
        return { ok: false, error: `${name}: "${s}" is not one of the choices.` };
      return { ok: true, value: s };
    }

    default:
      // person / people / file / relation / reference never reach here — the
      // form builder does not offer them and the public GET does not list them.
      return { ok: true, skip: true };
  }
}
