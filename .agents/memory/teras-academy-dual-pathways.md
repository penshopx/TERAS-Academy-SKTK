---
name: TERAS Academy dual pathways
description: Controlled-baseline rules for separating domain, track, pathways, and pathway-specific outcomes.
---

Solar PV is an implementation domain and Solar PV Installation is a track/role. Path A means Capability Development; Path B means Pre-Certification. Installation and Design must not be used as pathway definitions.

**Why:** Master Architecture v1.0 locks the dual-pathway architecture and Solar PV M01–M10 baseline. Conflating role or technical area with pathway purpose makes catalogue, assessment, evidence, and final-status logic inconsistent.

**How to apply:** Model Domain → Track/Role → Pathway explicitly. Preserve stable IDs and learner history when correcting labels or semantics.

Both pathways may reuse a common learning foundation, but their purpose, assessment, evidence, output, and KPI remain distinct. Path A ends in Capability Achievement supported by a Capability Portfolio. Path B ends in Certification Readiness supported by a Certification Readiness Portfolio; external certification remains outside TERAS Academy.

**Why:** The controlled production rule is “build the learning once; differentiate the evidence and assessment according to the pathway.” Shared learning must not collapse capability achievement into certification readiness.

**How to apply:** Reuse learning assets where outcomes match, then attach pathway-specific assessment, evidence, decision, portfolio, and KPI contracts. Never duplicate the learning baseline solely to represent a different pathway purpose.

Shared learning authorization must follow the explicit pathway-to-baseline selection, not the pathway that physically owns the reusable activity row. Completion, verification, practice, and evidence events remain scoped to the learner's active pathway.

**Why:** A common activity can be stored once while both pathways use it. Requiring every event pathway to equal the reusable row's owner makes the second pathway read-only; removing all pathway checks would weaken isolation.

**How to apply:** Authorize cross-path use only when the active pathway explicitly selects the canonical baseline module. Keep learner/enrollment ownership and outcome-to-activity integrity enforced for every event.