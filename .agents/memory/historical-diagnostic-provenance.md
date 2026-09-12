---
name: Historical diagnostic provenance
description: How to recover auditable sources for diagnostic projections created before provenance was mandatory.
---

Reconstruct historical diagnostic provenance only from a complete session → response → question → option chain. For unit-level projections, the canonical question must map to the same competency unit.

**Why:** Legacy denormalized fields can be absent or inconsistent. Accepting a partial chain or fabricating identifiers would make the audit trail appear stronger than the source data supports.

**How to apply:** Keep unresolved records intact and place them in a reviewable exception report. Use stable source ordering and make the backfill safe to rerun so later source repairs can clear resolved exceptions.