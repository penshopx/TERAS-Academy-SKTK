BEGIN;

LOCK TABLE teras_readiness_gates IN SHARE ROW EXCLUSIVE MODE;

WITH ranked_active_rules AS (
  SELECT
    rule.id,
    row_number() OVER (
      PARTITION BY rule.pathway_id, rule.code
      ORDER BY rule.rule_version DESC, rule.created_at DESC, rule.id DESC
    ) AS active_rank
  FROM teras_readiness_gates AS rule
  WHERE rule.active = true
)
UPDATE teras_readiness_gates AS rule
SET active = false
FROM ranked_active_rules AS ranked
WHERE rule.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS teras_readiness_gates_one_active_unique
  ON teras_readiness_gates (pathway_id, code)
  WHERE active = true;

COMMIT;