import { Router, type IRouter } from "express";
import { readinessAuditPublicKeys } from "../lib/readiness-audit-signing";

const router: IRouter = Router();

router.get("/readiness-audit/public-keys", (_req, res) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      issuer: "TERAS",
      usage: "Verify Ed25519 signatures over the raw bytes of the hexadecimal SHA-256 checksum in TERAS readiness audit exports.",
      keys: readinessAuditPublicKeys(),
    });
  } catch {
    res.status(503).json({ error: "Readiness audit public keys are not configured" });
  }
});

export default router;