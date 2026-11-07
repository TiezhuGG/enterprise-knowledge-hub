CREATE TABLE correction_case (
 tenant_id uuid NOT NULL,id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,
 reporter_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('source_content','extraction','processing')),
 description text NOT NULL CHECK(char_length(description) BETWEEN 10 AND 2000),block_id uuid,
 job_id uuid,baseline_checkpoint integer NOT NULL CHECK(baseline_checkpoint BETWEEN 0 AND 4),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','awaiting_validation','resolved','dismissed')),
 assignee_id uuid,verified_by uuid,verified_at timestamptz,verification_note text,verified_sha256 text,
 replacement_version_id uuid,resolution_note text,closure_evidence jsonb,
 row_version integer NOT NULL DEFAULT 1,idempotency_hash text NOT NULL,payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,reporter_id,idempotency_hash),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,document_id,replacement_version_id) REFERENCES document_version(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,reporter_id) REFERENCES membership(tenant_id,id),
 FOREIGN KEY(tenant_id,assignee_id) REFERENCES membership(tenant_id,id),
 FOREIGN KEY(tenant_id,verified_by) REFERENCES membership(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
CREATE INDEX correction_page ON correction_case(tenant_id,document_id,version_id,created_at DESC,id DESC);
CREATE TABLE correction_event (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,seq integer NOT NULL,member_id uuid NOT NULL,
 action text NOT NULL,status text NOT NULL,note text NOT NULL,request_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,case_id,seq),FOREIGN KEY(tenant_id,case_id) REFERENCES correction_case(tenant_id,id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE TABLE correction_operation (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,
 PRIMARY KEY(tenant_id,case_id,member_id,key_hash),FOREIGN KEY(tenant_id,case_id) REFERENCES correction_case(tenant_id,id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE FUNCTION frozen_correction_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.document_id,NEW.version_id,NEW.reporter_id,NEW.kind,NEW.description,NEW.block_id,NEW.job_id,NEW.baseline_checkpoint,NEW.idempotency_hash,NEW.payload_hash,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.document_id,OLD.version_id,OLD.reporter_id,OLD.kind,OLD.description,OLD.block_id,OLD.job_id,OLD.baseline_checkpoint,OLD.idempotency_hash,OLD.payload_hash,OLD.created_at) OR NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Correction origin is immutable; revision must advance' USING ERRCODE='23514'; END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER frozen_correction_origin BEFORE UPDATE ON correction_case FOR EACH ROW EXECUTE FUNCTION frozen_correction_origin();
CREATE TRIGGER immutable_correction_event BEFORE UPDATE ON correction_event FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
