BEGIN;

CREATE TABLE IF NOT EXISTS teras_regulatory_references (
  id text PRIMARY KEY NOT NULL, type text NOT NULL, issuer text NOT NULL, number text NOT NULL,
  year integer NOT NULL, title text NOT NULL, enacted_date date NOT NULL, effective_date date NOT NULL,
  berita_negara text NOT NULL, authority_role text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE',
  content_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  CONSTRAINT teras_regulatory_references_role_check CHECK (authority_role IN ('DOMAIN_AUTHORITY','REGULATORY_CONTEXT')),
  CONSTRAINT teras_regulatory_references_status_check CHECK (status IN ('ACTIVE','SUPERSEDED','RETIRED','DRAFT')),
  CONSTRAINT teras_regulatory_references_sha256_check CHECK (content_sha256 ~ '^[0-9a-fA-F]{64}$'),
  UNIQUE (issuer, number, year)
);
CREATE TABLE IF NOT EXISTS teras_competency_framework_sources (
  id text PRIMARY KEY NOT NULL, framework_id text NOT NULL REFERENCES teras_competency_frameworks(id) ON DELETE CASCADE,
  regulatory_reference_id text NOT NULL REFERENCES teras_regulatory_references(id),
  provenance_type text NOT NULL DEFAULT 'AUTHORITATIVE', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  CONSTRAINT teras_framework_sources_provenance_check CHECK (provenance_type IN ('AUTHORITATIVE','CONTEXT','INTERNAL_DRAFT')),
  UNIQUE (framework_id, regulatory_reference_id)
);
CREATE OR REPLACE FUNCTION teras_check_authoritative_framework_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role_value text; status_value text;
BEGIN
  IF NEW.provenance_type = 'AUTHORITATIVE' THEN
    SELECT authority_role, status INTO role_value, status_value FROM teras_regulatory_references WHERE id = NEW.regulatory_reference_id;
    IF role_value IS DISTINCT FROM 'DOMAIN_AUTHORITY' OR status_value IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'authoritative framework linkage requires an active domain authority';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_framework_source_authority_guard ON teras_competency_framework_sources;
CREATE TRIGGER teras_framework_source_authority_guard BEFORE INSERT OR UPDATE ON teras_competency_framework_sources
FOR EACH ROW EXECUTE FUNCTION teras_check_authoritative_framework_source();
CREATE OR REPLACE FUNCTION teras_check_regulatory_reference_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE')
     OR (OLD.authority_role = 'DOMAIN_AUTHORITY' AND NEW.authority_role <> 'DOMAIN_AUTHORITY'))
     AND EXISTS (SELECT 1 FROM teras_competency_framework_sources
                 WHERE regulatory_reference_id = OLD.id AND provenance_type = 'AUTHORITATIVE') THEN
    RAISE EXCEPTION 'cannot deactivate a regulatory reference with authoritative framework linkages';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_regulatory_reference_deactivation_guard ON teras_regulatory_references;
CREATE TRIGGER teras_regulatory_reference_deactivation_guard BEFORE UPDATE OF status, authority_role ON teras_regulatory_references
FOR EACH ROW EXECUTE FUNCTION teras_check_regulatory_reference_deactivation();

ALTER TABLE teras_competency_units ADD COLUMN IF NOT EXISTS qualification_level integer;
ALTER TABLE teras_competency_units DROP CONSTRAINT IF EXISTS teras_competency_units_qualification_level_check;
ALTER TABLE teras_competency_units ADD CONSTRAINT teras_competency_units_qualification_level_check CHECK (qualification_level IS NULL OR qualification_level BETWEEN 1 AND 9);
ALTER TABLE teras_competency_frameworks ADD COLUMN IF NOT EXISTS authority_status text NOT NULL DEFAULT 'INTERNAL_DRAFT';
UPDATE teras_competency_frameworks SET authority_status = 'INTERNAL_DRAFT' WHERE authority_status IS NULL;
ALTER TABLE teras_competency_frameworks DROP CONSTRAINT IF EXISTS teras_competency_frameworks_authority_status_check;
ALTER TABLE teras_competency_frameworks ADD CONSTRAINT teras_competency_frameworks_authority_status_check CHECK (authority_status IN ('INTERNAL_DRAFT','AUTHORITATIVE'));

CREATE OR REPLACE FUNCTION teras_check_authoritative_framework() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authority_status = 'AUTHORITATIVE' AND NOT EXISTS (
    SELECT 1 FROM teras_competency_framework_sources s
    JOIN teras_regulatory_references r ON r.id = s.regulatory_reference_id
    WHERE s.framework_id = NEW.id AND s.provenance_type = 'AUTHORITATIVE'
      AND r.authority_role = 'DOMAIN_AUTHORITY' AND r.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'authoritative framework requires an active domain authority source';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_framework_authority_guard ON teras_competency_frameworks;
CREATE TRIGGER teras_framework_authority_guard BEFORE INSERT OR UPDATE OF authority_status
ON teras_competency_frameworks FOR EACH ROW EXECUTE FUNCTION teras_check_authoritative_framework();

CREATE TABLE IF NOT EXISTS teras_competency_elements (
  id text PRIMARY KEY NOT NULL, unit_id text NOT NULL REFERENCES teras_competency_units(id) ON DELETE CASCADE,
  code text NOT NULL, title text NOT NULL, description text NOT NULL, sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  UNIQUE(unit_id, code), UNIQUE(unit_id, sequence), CHECK(sequence > 0)
);
CREATE TABLE IF NOT EXISTS teras_competency_kuks (
  id text PRIMARY KEY NOT NULL, element_id text NOT NULL REFERENCES teras_competency_elements(id) ON DELETE CASCADE,
  code text NOT NULL, statement text NOT NULL, sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  UNIQUE(element_id, code), UNIQUE(element_id, sequence), CHECK(sequence > 0)
);
CREATE TABLE IF NOT EXISTS teras_qualification_packages (
  id text PRIMARY KEY NOT NULL, framework_id text NOT NULL REFERENCES teras_competency_frameworks(id) ON DELETE CASCADE,
  level integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  UNIQUE(framework_id, level), CHECK(level BETWEEN 1 AND 9)
);
CREATE TABLE IF NOT EXISTS teras_qualification_package_units (
  id text PRIMARY KEY NOT NULL, package_id text NOT NULL REFERENCES teras_qualification_packages(id) ON DELETE CASCADE,
  unit_id text NOT NULL REFERENCES teras_competency_units(id), category text NOT NULL, sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'system',
  UNIQUE(package_id, unit_id), CHECK(category IN ('CORE','ELECTIVE_A','ELECTIVE_B')), CHECK(sequence > 0)
);

INSERT INTO teras_regulatory_references
 (id,type,issuer,number,year,title,enacted_date,effective_date,berita_negara,authority_role,status,content_sha256)
VALUES
 ('reg-permen-esdm-6-2021','PERMEN','Kementerian Energi dan Sumber Daya Mineral','6',2021,'Standardisasi Kompetensi Tenaga Teknik Ketenagalistrikan','2021-04-01','2021-04-01','Berita Negara 2021 No. 328','DOMAIN_AUTHORITY','ACTIVE','827b2da42b6c78af3d55ec69f70cdc624eabd8aef32474698dd0326b6f038ca2'),
 ('reg-permen-esdm-5-2021','PERMEN','Kementerian Energi dan Sumber Daya Mineral','5',2021,'Standar Kegiatan Usaha dan Produk pada Penyelenggaraan Perizinan Berusaha Berbasis Risiko Sektor Energi dan Sumber Daya Mineral','2021-04-01','2021-04-01','Berita Negara 2021 No. 318','REGULATORY_CONTEXT','ACTIVE','299a649b262dcea59931727adce93e562b2cd609af9c5e7e7d518d853f502429')
ON CONFLICT (issuer,number,year) DO UPDATE SET type=EXCLUDED.type, title=EXCLUDED.title,
 enacted_date=EXCLUDED.enacted_date, effective_date=EXCLUDED.effective_date,
 berita_negara=EXCLUDED.berita_negara, authority_role=EXCLUDED.authority_role,
 status=EXCLUDED.status, content_sha256=EXCLUDED.content_sha256, updated_at=now();
COMMIT;