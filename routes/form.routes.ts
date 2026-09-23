import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { moduleFrom, requireModuleAccess } from "../middleware/access.middleware";
import { getForm, upsertForm, resetFormLink } from "../controllers/form.controller";

const router = Router();

// Every route is board-scoped by the moduleId path param. Config writes
// additionally check owner|admin inside the controller.
router.get("/:moduleId", protect, requireModuleAccess(moduleFrom.param), getForm);
router.put("/:moduleId", protect, requireModuleAccess(moduleFrom.param), upsertForm);
router.post(
  "/:moduleId/reset-link",
  protect,
  requireModuleAccess(moduleFrom.param),
  resetFormLink
);

export default router;
