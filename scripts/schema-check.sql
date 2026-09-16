DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
  FROM (
    VALUES
      ('teras_people', 'email', 'YES'),
      ('teras_modules', 'pathway_id', 'NO'),
      ('teras_practice_attempts', 'pathway_id', 'NO'),
      ('teras_evidence', 'pathway_id', 'NO'),
      ('teras_assessment_attempts', 'pathway_id', 'NO'),
      ('teras_gaps', 'pathway_id', 'NO'),
      ('teras_assessments', 'gate_code', 'YES'),
      ('teras_readiness_gates', 'pathway_id', 'NO'),
      ('teras_readiness_gates', 'assessment_mode', 'NO'),
      ('teras_readiness_gates', 'evidence_mode', 'NO'),
      ('teras_readiness_events', 'pathway_id', 'NO'),
      ('teras_courses', 'pathway_id', 'NO'),
      ('teras_course_modules', 'module_id', 'NO'),
      ('teras_lessons', 'course_module_id', 'NO'),
      ('teras_learning_activities', 'pathway_id', 'NO'),
      ('teras_content_resource_uri_audit', 'original_uri', 'NO'),
      ('teras_learning_outcomes', 'activity_id', 'NO'),
      ('teras_activity_completion_events', 'learner_id', 'NO'),
      ('teras_outcome_verification_events', 'learner_id', 'NO'),
      ('teras_learning_record_links', 'pathway_id', 'NO'),
      ('teras_reassessment_links', 'reassessment_attempt_id', 'NO'),
      ('teras_readiness_transfer_events', 'source_context', 'NO'),
      ('teras_learning_transition_events', 'idempotency_key', 'NO')
      ,('teras_pathway_module_contracts', 'assessment_id', 'NO')
      ,('teras_pathway_module_contracts', 'evidence_requirement_id', 'NO')
      ,('teras_pathway_module_contracts', 'gate_code', 'NO')
  ) AS expected(table_name, column_name, is_nullable)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
      AND actual.is_nullable = expected.is_nullable
  );

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Critical TERAS runtime schema fields are missing or have incorrect nullability';
  END IF;

  IF EXISTS (SELECT 1 FROM teras_modules WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_practice_attempts WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_evidence WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_assessment_attempts WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_gaps WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_readiness_gates WHERE pathway_id IS NULL)
    OR EXISTS (SELECT 1 FROM teras_readiness_events WHERE pathway_id IS NULL) THEN
    RAISE EXCEPTION 'Pathway backfill is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_people_email_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_modules_pathway_id_teras_pathways_id_fk' AND contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_readiness_gates_pathway_id_teras_pathways_id_fk' AND contype = 'f'
  ) OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'teras_content_resources'::regclass
        AND conname = 'teras_content_resources_uri_http_check'
        AND contype = 'c'
        AND convalidated
  ) THEN
    RAISE EXCEPTION 'Critical TERAS runtime constraints are missing';
  END IF;

  IF to_regclass('public.teras_diagnostic_provenance_exceptions') IS NULL
    OR to_regclass('public.teras_diagnostic_provenance_check_runs') IS NULL
    OR to_regclass('public.teras_diagnostic_provenance_check_counts') IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname IN (
        'teras_diagnostic_profiles_provenance_check',
        'teras_diagnostic_profile_items_provenance_check',
        'teras_diagnostic_gaps_provenance_check'
      )
        AND NOT convalidated
    )
    OR (
      SELECT count(*)
      FROM pg_constraint
      WHERE conname IN (
        'teras_diagnostic_profiles_provenance_check',
        'teras_diagnostic_profile_items_provenance_check',
        'teras_diagnostic_gaps_provenance_check'
      )
        AND convalidated
    ) <> 3 THEN
    RAISE EXCEPTION 'Diagnostic provenance reporting or validated constraints are incomplete';
  END IF;

  IF to_regclass('public.teras_courses') IS NULL
    OR to_regclass('public.teras_course_modules') IS NULL
    OR to_regclass('public.teras_lessons') IS NULL
    OR to_regclass('public.teras_learning_activities') IS NULL
    OR to_regclass('public.teras_content_resources') IS NULL
    OR to_regclass('public.teras_content_resource_uri_audit') IS NULL
    OR to_regclass('public.teras_learning_outcomes') IS NULL
    OR to_regclass('public.teras_activity_completion_events') IS NULL
    OR to_regclass('public.teras_outcome_verification_events') IS NULL
    OR to_regclass('public.teras_learning_record_links') IS NULL
    OR to_regclass('public.teras_reassessment_links') IS NULL
    OR to_regclass('public.teras_readiness_transfer_events') IS NULL
    OR to_regclass('public.teras_learning_transition_events') IS NULL THEN
    RAISE EXCEPTION 'Phase 1 LMS foundation tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM teras_content_resources
    WHERE uri IS NOT NULL
    AND (
      uri ~ '[[:space:]]'
      OR uri !~* '^https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?::(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?#][^[:space:]]*)?$'
      OR (
        uri ~* '^https?://[0-9.]+(?:[/:?#]|$)'
        AND uri !~* '^https?://(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?::(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?#]|$)'
      )
    )
  ) THEN
    RAISE EXCEPTION 'Unsafe content resource URI remains after quarantine';
  END IF;

  IF to_regclass('public.teras_learning_transition_idempotency_unique') IS NULL THEN
    RAISE EXCEPTION 'Learning transition idempotency constraint is missing';
  END IF;

  IF to_regclass('public.teras_practice_reviews_latest_idx') IS NULL THEN
    RAISE EXCEPTION 'Latest practice review lookup index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = 'teras_learning_transition_idempotency_unique'::regclass
      AND indisunique
  ) THEN
    RAISE EXCEPTION 'Learning transition idempotency index is not unique';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid IN (
      'teras_activity_completion_lookup_idx'::regclass,
      'teras_outcome_verification_lookup_idx'::regclass,
      'teras_learning_record_links_pathway_activity_created_idx'::regclass,
      'teras_readiness_transfer_lookup_idx'::regclass,
      'teras_learning_transition_state_lookup_idx'::regclass
    )
      AND indisunique
  ) THEN
    RAISE EXCEPTION 'Append-only event lookup indexes must not enforce timestamp uniqueness';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('m01','path-a'),('m02','path-a'),('m03','path-a'),('m04','path-a'),('m05','path-a'),
      ('m06','path-a'),('m07','path-a'),('m08','path-a'),('m09','path-a'),('m10','path-a'),
      ('b01','path-b'),('b02','path-b'),('b03','path-b'),('b04','path-b'),
      ('b05','path-b'),('b06','path-b'),('b07','path-b'),('b08','path-b')
    ) expected(id, pathway_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM teras_modules actual
      WHERE actual.id = expected.id AND actual.pathway_id = expected.pathway_id
    )
  ) THEN
    RAISE EXCEPTION 'Canonical pathway curriculum is incomplete or assigned to the wrong pathway';
  END IF;

  IF to_regclass('public.teras_learning_baselines') IS NULL
    OR to_regclass('public.teras_baseline_modules') IS NULL
    OR to_regclass('public.teras_pathway_baseline_modules') IS NULL
    OR to_regclass('public.teras_pathway_module_contracts') IS NULL
    OR to_regclass('public.teras_legacy_module_mappings') IS NULL THEN
    RAISE EXCEPTION 'Shared Solar PV baseline tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      (1,'M01','Fundamentals','Explain PV principles, terminology, and system purpose.','E01'),
      (2,'M02','Measurement & Interpretation','Measure and interpret site and system data to identify relevant PV conditions.','E02'),
      (3,'M03','Safety & Work Practice','Apply safe work practices, isolation, and risk controls for PV work.','E03'),
      (4,'M04','System Architecture','Describe PV system architecture and explain component interfaces.','E04'),
      (5,'M05','Drawing & Work Preparation','Produce accurate drawings and work preparation records for PV installation.','E05'),
      (6,'M06','Mechanical Installation','Install and secure PV mechanical components in accordance with drawings and manufacturer requirements.','E06'),
      (7,'M07','Electrical Installation','Install PV electrical components, cabling, protection, and terminations safely.','E07'),
      (8,'M08','System Configuration & Integration','Configure and integrate inverter, monitoring, and system controls.','E08'),
      (9,'M09','Testing & Commissioning','Test, commission, and document PV system performance and safety.','E09'),
      (10,'M10','O&M & Basic Troubleshooting','Perform routine O&M and basic troubleshooting using safe diagnostic steps.','E10')
    ) expected(sequence, code, name, outcome, evidence_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM teras_baseline_modules actual
      WHERE actual.baseline_id = 'baseline-solar-pv-v1'
        AND actual.sequence = expected.sequence
        AND actual.code = expected.code
        AND actual.name = expected.name
        AND actual.learning_outcome = expected.outcome
        AND actual.evidence_id = expected.evidence_id
    )
  ) THEN
    RAISE EXCEPTION 'Solar PV M01-M10 baseline sequence, names, outcomes, or evidence IDs are incorrect';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('m01','E01'),('m02','E02'),('m03','E03'),('m04','E04'),('m05','E05'),
      ('m06','E06'),('m07','E07'),('m08','E08'),('m09','E09'),('m10','E10')
    ) expected(module_id, evidence_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM teras_evidence_requirements er
      WHERE er.module_id = expected.module_id AND er.code = expected.evidence_id
    )
  ) THEN
    RAISE EXCEPTION 'Stable E01-E10 evidence requirement records are incomplete';
  END IF;

  IF (SELECT count(*) FROM teras_pathway_baseline_modules WHERE baseline_module_id IN (SELECT id FROM teras_baseline_modules WHERE baseline_id = 'baseline-solar-pv-v1') AND pathway_id = 'path-a') <> 10
    OR (SELECT count(*) FROM teras_pathway_baseline_modules WHERE baseline_module_id IN (SELECT id FROM teras_baseline_modules WHERE baseline_id = 'baseline-solar-pv-v1') AND pathway_id = 'path-b') <> 10
    OR (SELECT count(*) FROM teras_pathway_module_contracts WHERE pathway_id = 'path-a') <> 10
    OR (SELECT count(*) FROM teras_pathway_module_contracts WHERE pathway_id = 'path-b') <> 10
    OR EXISTS (
      SELECT 1 FROM teras_pathway_module_contracts
      WHERE assessment_id = '' OR evidence_requirement_id = '' OR gate_code = ''
    )
    OR EXISTS (
      SELECT 1 FROM teras_pathway_module_contracts c
      WHERE c.assessment_id <> 'assessment-' || c.module_id
         OR c.evidence_requirement_id <> 'req-' || c.module_id
         OR c.gate_code <> CASE
           WHEN c.pathway_id = 'path-a' AND c.module_id IN ('m01','m02','m03') THEN 'G1'
           WHEN c.pathway_id = 'path-a' AND c.module_id IN ('m04','m05','m06','m07') THEN 'G2'
           WHEN c.pathway_id = 'path-a' THEN 'G3'
           WHEN c.pathway_id = 'path-b' AND c.module_id IN ('m01','m02','m03') THEN 'B1'
           WHEN c.pathway_id = 'path-b' AND c.module_id IN ('m04','m05','m06','m07') THEN 'B2'
           WHEN c.pathway_id = 'path-b' AND c.module_id IN ('m08','m09') THEN 'B3'
           WHEN c.pathway_id = 'path-b' AND c.module_id = 'm10' THEN 'B4'
           ELSE ''
         END
    )
    OR EXISTS (
      SELECT 1 FROM teras_readiness_gates g
      WHERE g.active
        AND NOT EXISTS (
          SELECT 1 FROM teras_pathway_module_contracts c
          WHERE c.pathway_id = g.pathway_id AND c.gate_code = g.code
        )
    )
    OR EXISTS (
      SELECT 1 FROM (VALUES
        ('path-a','G1',3),('path-a','G2',4),('path-a','G3',3),
        ('path-b','B1',3),('path-b','B2',4),('path-b','B3',2),('path-b','B4',1)
      ) expected(pathway_id, gate_code, requirement_count)
      WHERE (SELECT count(*) FROM teras_pathway_module_contracts c
             WHERE c.pathway_id = expected.pathway_id AND c.gate_code = expected.gate_code) <> expected.requirement_count
    )
    OR EXISTS (
      SELECT 1
      FROM teras_pathway_module_contracts a
      JOIN teras_pathway_module_contracts b ON b.module_id = a.module_id
      WHERE a.pathway_id = 'path-a' AND b.pathway_id = 'path-b'
        AND (a.assessment = b.assessment OR a.output = b.output OR a.kpi = b.kpi OR a.portfolio = b.portfolio)
    ) THEN
    RAISE EXCEPTION 'Shared baseline pathway mappings or differentiated pathway contracts are incomplete';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM teras_legacy_module_mappings
      GROUP BY legacy_module_id
      HAVING count(DISTINCT baseline_module_id) > 1
    )
    OR (SELECT count(*) FROM teras_legacy_module_mappings WHERE pathway_id = 'path-b' AND status = 'retired') <> 8
    OR EXISTS (
      SELECT 1 FROM (VALUES
        ('b01','M05'),('b02','M02'),('b03','M04'),('b04','M07'),
        ('b05','M06'),('b06','M08'),('b07','M09'),('b08','M10')
      ) expected(legacy_id, baseline_code)
      WHERE NOT EXISTS (
        SELECT 1
        FROM teras_legacy_module_mappings lm
        JOIN teras_baseline_modules bm ON bm.id = lm.baseline_module_id
        WHERE lm.legacy_module_id = expected.legacy_id
          AND bm.code = expected.baseline_code
          AND lm.status = 'retired'
      )
    ) THEN
    RAISE EXCEPTION 'Legacy B01-B08 compatibility mappings are incomplete or ambiguous';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('gate-g1','path-a'),('gate-g2','path-a'),('gate-g3','path-a'),
      ('gate-b1','path-b'),('gate-b2','path-b'),('gate-b3','path-b'),('gate-b4','path-b')
    ) expected(id, pathway_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM teras_readiness_gates actual
      WHERE actual.id = expected.id AND actual.pathway_id = expected.pathway_id
    )
  ) THEN
    RAISE EXCEPTION 'Canonical readiness gates are incomplete or assigned to the wrong pathway';
  END IF;

  IF (SELECT count(*) FROM teras_courses WHERE program_id = 'solar-pv-tech' AND pathway_id = 'path-a') < 1
    OR (SELECT count(*) FROM teras_courses WHERE program_id = 'solar-pv-tech' AND pathway_id = 'path-b') < 1
    OR (SELECT count(*) FROM teras_learning_activities WHERE pathway_id = 'path-a') < 1
    OR (SELECT count(*) FROM teras_learning_activities WHERE pathway_id = 'path-b') < 1
    OR (SELECT count(*) FROM teras_course_modules cm JOIN teras_modules m ON m.id = cm.module_id
        WHERE cm.pathway_id = 'path-a' AND m.code LIKE 'M%') <> 10
    OR (SELECT count(*) FROM teras_pathway_baseline_modules pbm
        JOIN teras_baseline_modules bm ON bm.id = pbm.baseline_module_id
        WHERE pbm.pathway_id = 'path-b' AND bm.code LIKE 'M%') <> 10
    OR EXISTS (
      SELECT 1 FROM teras_course_modules cm
      JOIN teras_modules m ON m.id = cm.module_id
      WHERE cm.pathway_id = 'path-b' AND cm.status <> 'ARCHIVED' AND m.code LIKE 'M%'
    )
    OR EXISTS (
      SELECT 1
      FROM teras_course_modules cm
      JOIN teras_modules m ON m.id = cm.module_id
      WHERE m.code LIKE 'M%' AND cm.status <> 'ARCHIVED'
        AND NOT EXISTS (
          SELECT 1
          FROM teras_lessons l
          JOIN teras_learning_activities a ON a.lesson_id = l.id
          JOIN teras_learning_outcomes o ON o.activity_id = a.id
          WHERE l.course_module_id = cm.id AND o.capability_module_id = m.id
        )
    ) THEN
    RAISE EXCEPTION 'Seeded Phase 1 LMS hierarchy is missing a pathway';
  END IF;
END $$;

DO $$
DECLARE
  current_run_id bigint;
  previous_run_id bigint;
  exception_group record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('teras_diagnostic_provenance_schema_check'));

  SELECT max(id)
  INTO previous_run_id
  FROM teras_diagnostic_provenance_check_runs;

  INSERT INTO teras_diagnostic_provenance_check_runs DEFAULT VALUES
  RETURNING id INTO current_run_id;

  INSERT INTO teras_diagnostic_provenance_check_counts
    (check_run_id, entity_type, reason, exception_count)
  SELECT current_run_id, entity_type, reason, count(*)::integer
  FROM teras_diagnostic_provenance_exceptions
  GROUP BY entity_type, reason;

  IF NOT EXISTS (
    SELECT 1
    FROM teras_diagnostic_provenance_check_counts
    WHERE check_run_id = current_run_id
  ) THEN
    RAISE NOTICE 'TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS total=0';
  END IF;

  FOR exception_group IN
    SELECT
      current.entity_type,
      current.reason,
      current.exception_count,
      current.exception_count - COALESCE(previous.exception_count, 0) AS delta
    FROM teras_diagnostic_provenance_check_counts current
    LEFT JOIN teras_diagnostic_provenance_check_counts previous
      ON previous.check_run_id = previous_run_id
      AND previous.entity_type = current.entity_type
      AND previous.reason = current.reason
    WHERE current.check_run_id = current_run_id
    ORDER BY current.entity_type, current.reason
  LOOP
    RAISE NOTICE
      'TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=% reason=% count=% delta=%',
      exception_group.entity_type,
      exception_group.reason,
      exception_group.exception_count,
      exception_group.delta;

    IF previous_run_id IS NOT NULL AND exception_group.delta > 0 THEN
      RAISE WARNING
        'TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE entity_type=% reason=% previous_count=% current_count=% delta=%',
        exception_group.entity_type,
        exception_group.reason,
        exception_group.exception_count - exception_group.delta,
        exception_group.exception_count,
        exception_group.delta;
    END IF;
  END LOOP;
END $$;

SELECT 'TERAS schema regression checks passed' AS result;