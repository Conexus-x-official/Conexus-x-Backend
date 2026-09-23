import { Router } from "express";
import { memoryRateLimit } from "../middleware/rateLimit.middleware";
import { getPublicForm, submitPublicForm } from "../controllers/publicForm.controller";

/**
 * PUBLIC form routes — NO `protect`. This is the only router in the app a
 * stranger can reach without a token, so the guard rails are here instead:
 * the GET is read-only and leaks nothing internal, and the POST is throttled
 * per IP (fixed window, in-memory — see the middleware for the single-process
 * caveat) with a honeypot check inside the controller on top.
 */
const router = Router();

router.get("/:publicId", memoryRateLimit({ windowMs: 60_000, max: 60 }), getPublicForm);

router.post(
  "/:publicId/submit",
  memoryRateLimit({ windowMs: 60_000, max: 5 }),
  submitPublicForm
);

export default router;
