#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$repo_root"
: "${DATABASE_URL:?DATABASE_URL must be set}"
schema="teras_path_b_regulatory_test_$$"
cleanup() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null; }
trap cleanup EXIT
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
CREATE TABLE "$schema".teras_pathways (id text PRIMARY KEY, program_id text NOT NULL, name text NOT NULL, type text NOT NULL, outcome text NOT NULL);
CREATE TABLE "$schema".teras_modules (id text PRIMARY KEY);
CREATE TABLE "$schema".teras_practice_tasks (id text PRIMARY KEY, module_id text NOT NULL);
CREATE TABLE "$schema".teras_evidence_requirements (id text PRIMARY KEY, module_id text NOT NULL);
CREATE TABLE "$schema".teras_learning_activities (id text PRIMARY KEY);
CREATE TABLE "$schema".teras_learning_outcomes (id text PRIMARY KEY, activity_id text NOT NULL, description text NOT NULL, verification_method text NOT NULL);
INSERT INTO "$schema".teras_pathways VALUES ('path-a','program','Path A','Primary','Install');
SQL
export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0016_competency_frameworks.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0054_path_b_regulatory_competency_foundation.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO teras_competency_frameworks (id,code,name,description,status)
VALUES ('framework-skttk-solar-pv','SKTTK-SPV','SKTTK Solar PV','Internal draft','active');
INSERT INTO teras_competency_units (id,framework_id,code,title,description,status,sequence)
VALUES ('skttk-u-01','framework-skttk-solar-pv','SKTTK-SPV-01','Internal unit','Internal draft','active',1),
       ('skttk-u-02','framework-skttk-solar-pv','SKTTK-SPV-02','Internal unit','Internal draft','active',2),
       ('skttk-u-03','framework-skttk-solar-pv','SKTTK-SPV-03','Internal unit','Internal draft','active',3);
DO $$
DECLARE n integer; ok boolean;
BEGIN
  SELECT count(*) INTO n FROM teras_regulatory_references;
  IF n <> 2 OR (SELECT count(*) FROM teras_regulatory_references WHERE content_sha256 IN ('827b2da42b6c78af3d55ec69f70cdc624eabd8aef32474698dd0326b6f038ca2','299a649b262dcea59931727adce93e562b2cd609af9c5e7e7d518d853f502429')) <> 2 THEN RAISE EXCEPTION 'regulatory seed mismatch'; END IF;
  IF (SELECT authority_status FROM teras_competency_frameworks WHERE id='framework-skttk-solar-pv') <> 'INTERNAL_DRAFT' OR (SELECT status FROM teras_competency_frameworks WHERE id='framework-skttk-solar-pv') <> 'active' THEN RAISE EXCEPTION 'synthetic framework provenance mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM teras_competency_framework_sources WHERE framework_id='framework-skttk-solar-pv') OR (SELECT count(*) FROM teras_competency_units WHERE code LIKE 'SKTTK-SPV-%') <> 3 THEN RAISE EXCEPTION 'synthetic linkage/content mismatch'; END IF;
  BEGIN INSERT INTO teras_competency_framework_sources VALUES ('bad-context','framework-skttk-solar-pv','reg-permen-esdm-5-2021','AUTHORITATIVE',now(),now(),'test'); RAISE EXCEPTION 'context accepted'; EXCEPTION WHEN others THEN IF SQLERRM = 'context accepted' THEN RAISE; END IF; END;
  BEGIN UPDATE teras_competency_frameworks SET authority_status='AUTHORITATIVE' WHERE id='framework-skttk-solar-pv'; RAISE EXCEPTION 'authority transition accepted'; EXCEPTION WHEN others THEN IF SQLERRM = 'authority transition accepted' THEN RAISE; END IF; END;
  INSERT INTO teras_competency_framework_sources VALUES ('good-source','framework-skttk-solar-pv','reg-permen-esdm-6-2021','AUTHORITATIVE',now(),now(),'test');
  UPDATE teras_competency_frameworks SET authority_status='AUTHORITATIVE' WHERE id='framework-skttk-solar-pv';
  BEGIN UPDATE teras_regulatory_references SET status='RETIRED' WHERE id='reg-permen-esdm-6-2021'; RAISE EXCEPTION 'demotion accepted'; EXCEPTION WHEN others THEN IF SQLERRM = 'demotion accepted' THEN RAISE; END IF; END;
  INSERT INTO teras_competency_elements VALUES ('e1','skttk-u-01','E1','Element','Element',1,now(),now(),'test');
  BEGIN INSERT INTO teras_competency_elements VALUES ('e2','skttk-u-01','E2','Element','Element',1,now(),now(),'test'); RAISE EXCEPTION 'element order duplicate accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO teras_competency_kuks VALUES ('k1','e1','K1','KUK',1,now(),now(),'test');
  BEGIN INSERT INTO teras_competency_kuks VALUES ('k2','e1','K2','KUK',1,now(),now(),'test'); RAISE EXCEPTION 'KUK order duplicate accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO teras_qualification_packages VALUES ('p0','framework-skttk-solar-pv',0,now(),now(),'test'); RAISE EXCEPTION 'level 0 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO teras_qualification_packages VALUES ('p10','framework-skttk-solar-pv',10,now(),now(),'test'); RAISE EXCEPTION 'level 10 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO teras_qualification_package_units VALUES ('pu','p0','skttk-u-01','INVALID',1,now(),now(),'test'); RAISE EXCEPTION 'invalid category accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SQL
echo "Path B regulatory isolated-schema integration passed"