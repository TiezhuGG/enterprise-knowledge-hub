CREATE TABLE document_tombstone (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,kb_id uuid NOT NULL,member_id uuid NOT NULL,actor_id uuid NOT NULL,
 request_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id),FOREIGN KEY(tenant_id,document_id) REFERENCES document(tenant_id,id),FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE TRIGGER immutable_tombstone BEFORE UPDATE OR DELETE ON document_tombstone FOR EACH ROW EXECUTE FUNCTION immutable_document_version();
CREATE FUNCTION reject_document_resurrection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM document_tombstone WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id) AND (NEW.status<>'deleted' OR NEW.published_version_id IS NOT NULL OR NEW.published_generation_id IS NOT NULL) THEN RAISE EXCEPTION 'Deleted document cannot be revived' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER reject_document_resurrection BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION reject_document_resurrection();
ALTER TABLE ingestion_attempt ADD COLUMN write_protocol text NOT NULL DEFAULT 'legacy';
CREATE TABLE storage_write (
 tenant_id uuid NOT NULL,id uuid NOT NULL,document_id uuid NOT NULL,job_id uuid,kind text NOT NULL,storage_key text,
 status text NOT NULL CHECK(status IN ('running','settled','unknown','reconciled')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX storage_write_document ON storage_write(tenant_id,document_id,status);
CREATE TABLE vector_binding (
 tenant_id uuid NOT NULL,generation_id uuid NOT NULL,storage_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,generation_id),FOREIGN KEY(tenant_id,generation_id) REFERENCES index_generation(tenant_id,id)
);
CREATE TRIGGER immutable_vector_binding BEFORE UPDATE ON vector_binding FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TABLE document_cleanup (
 tenant_id uuid NOT NULL,id uuid NOT NULL,document_id uuid NOT NULL,kb_id uuid NOT NULL,member_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','retry_wait','waiting_dependency','failed','succeeded')),
 stage text NOT NULL DEFAULT 'retention',not_before timestamptz NOT NULL,next_run_at timestamptz NOT NULL DEFAULT now(),
 attempt_count integer NOT NULL DEFAULT 0,run_no integer NOT NULL DEFAULT 1,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,document_id),FOREIGN KEY(tenant_id,document_id) REFERENCES document_tombstone(tenant_id,document_id)
);
CREATE TABLE deletion_request (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,document_id uuid NOT NULL,cleanup_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,member_id,key_hash),FOREIGN KEY(tenant_id,cleanup_id) REFERENCES document_cleanup(tenant_id,id)
);
CREATE TABLE cleanup_item (
 tenant_id uuid NOT NULL,cleanup_id uuid NOT NULL,id text NOT NULL,kind text NOT NULL CHECK(kind IN ('object','vector','pg')),
 target jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,cleanup_id,id),FOREIGN KEY(tenant_id,cleanup_id) REFERENCES document_cleanup(tenant_id,id)
);
CREATE TABLE cleanup_event (
 seq bigserial PRIMARY KEY,tenant_id uuid NOT NULL,cleanup_id uuid NOT NULL,kind text NOT NULL,error_code text,member_id uuid,worker_id text,
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,cleanup_id) REFERENCES document_cleanup(tenant_id,id)
);
CREATE TRIGGER immutable_cleanup_event BEFORE UPDATE ON cleanup_event FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
ALTER TABLE chat_run ADD COLUMN content_expires_at timestamptz;
ALTER TABLE chat_run ADD COLUMN content_purged_at timestamptz;
CREATE OR REPLACE FUNCTION frozen_chat_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- One migration backfill, then one destructive content scrub; neither changes run identity or terminal outcome.
 IF OLD.content_expires_at IS NULL AND NEW.content_expires_at=OLD.created_at+interval '30 days' AND (to_jsonb(NEW)-'content_expires_at')=(to_jsonb(OLD)-'content_expires_at') THEN RETURN NEW; END IF;
 IF OLD.status<>'running' AND OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND (OLD.content_expires_at<=now() OR EXISTS(SELECT 1 FROM conversation v WHERE v.tenant_id=OLD.tenant_id AND v.id=OLD.conversation_id AND v.deleted_at IS NOT NULL) OR EXISTS(SELECT 1 FROM document_tombstone t WHERE t.tenant_id=OLD.tenant_id AND OLD.dependencies @> jsonb_build_array(jsonb_build_object('document_id',t.document_id::text)))) AND NEW.result IS NULL AND NEW.dependencies='[]'::jsonb AND NEW.input='{"query":"[历史内容已清理]"}'::jsonb AND (to_jsonb(NEW)-ARRAY['input','result','dependencies','content_purged_at'])=(to_jsonb(OLD)-ARRAY['input','result','dependencies','content_purged_at']) THEN RETURN NEW; END IF;
 IF OLD.status<>'running' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Chat terminal is immutable' USING ERRCODE='23514'; END IF;
 IF (OLD.tenant_id,OLD.id,OLD.conversation_id,OLD.member_id,OLD.input,OLD.payload_hash,OLD.idempotency_hash,OLD.message_id,OLD.question_message_id,OLD.parent_run_id,OLD.created_at,OLD.content_expires_at,OLD.content_purged_at) IS DISTINCT FROM (NEW.tenant_id,NEW.id,NEW.conversation_id,NEW.member_id,NEW.input,NEW.payload_hash,NEW.idempotency_hash,NEW.message_id,NEW.question_message_id,NEW.parent_run_id,NEW.created_at,NEW.content_expires_at,NEW.content_purged_at) THEN RAISE EXCEPTION 'Chat identity is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
UPDATE chat_run SET content_expires_at=created_at+interval '30 days';
ALTER TABLE chat_run ALTER COLUMN content_expires_at SET NOT NULL;
ALTER TABLE chat_run ALTER COLUMN content_expires_at SET DEFAULT now()+interval '30 days';
CREATE INDEX chat_dependencies ON chat_run USING gin(dependencies jsonb_path_ops);
CREATE TABLE history_purge_log (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,reason text NOT NULL,document_id uuid,purged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES chat_run(tenant_id,id)
);
CREATE TRIGGER immutable_history_purge_log BEFORE UPDATE ON history_purge_log FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
ALTER TABLE source_asset ADD COLUMN content_purged_at timestamptz;
CREATE OR REPLACE FUNCTION immutable_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND NEW.filename='[已清理]' AND (to_jsonb(NEW)-ARRAY['filename','content_purged_at'])=(to_jsonb(OLD)-ARRAY['filename','content_purged_at']) AND EXISTS(SELECT 1 FROM document_version v JOIN document_tombstone t ON t.tenant_id=v.tenant_id AND t.document_id=v.document_id WHERE v.tenant_id=OLD.tenant_id AND v.source_asset_id=OLD.id) THEN RETURN NEW; END IF;
 IF (NEW.tenant_id,NEW.id,NEW.object_key,NEW.object_version,NEW.size,NEW.mime,NEW.filename,NEW.sha256,NEW.created_at,NEW.content_purged_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.object_key,OLD.object_version,OLD.size,OLD.mime,OLD.filename,OLD.sha256,OLD.created_at,OLD.content_purged_at) THEN RAISE EXCEPTION 'Source identity is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
ALTER TABLE correction_case ADD COLUMN content_purged_at timestamptz;
CREATE OR REPLACE FUNCTION frozen_correction_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND NEW.description='[关联来源已删除，正文已清理]' AND NEW.verification_note IS NULL AND NEW.resolution_note IS NULL AND NEW.closure_evidence IS NULL AND NEW.row_version=OLD.row_version+1 AND (to_jsonb(NEW)-ARRAY['description','verification_note','resolution_note','closure_evidence','content_purged_at','row_version','updated_at'])=(to_jsonb(OLD)-ARRAY['description','verification_note','resolution_note','closure_evidence','content_purged_at','row_version','updated_at']) AND EXISTS(SELECT 1 FROM document_tombstone t WHERE t.tenant_id=OLD.tenant_id AND t.document_id=OLD.document_id) THEN RETURN NEW; END IF;
 IF (NEW.tenant_id,NEW.id,NEW.document_id,NEW.version_id,NEW.reporter_id,NEW.kind,NEW.description,NEW.block_id,NEW.job_id,NEW.baseline_checkpoint,NEW.idempotency_hash,NEW.payload_hash,NEW.created_at,NEW.content_purged_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.document_id,OLD.version_id,OLD.reporter_id,OLD.kind,OLD.description,OLD.block_id,OLD.job_id,OLD.baseline_checkpoint,OLD.idempotency_hash,OLD.payload_hash,OLD.created_at,OLD.content_purged_at) OR NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Correction origin is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
ALTER TABLE correction_event ADD COLUMN content_purged_at timestamptz;
CREATE FUNCTION protect_correction_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND NEW.note='[内容已清理]' AND (to_jsonb(NEW)-ARRAY['note','content_purged_at'])=(to_jsonb(OLD)-ARRAY['note','content_purged_at']) AND EXISTS(SELECT 1 FROM correction_case c JOIN document_tombstone t ON t.tenant_id=c.tenant_id AND t.document_id=c.document_id WHERE c.tenant_id=OLD.tenant_id AND c.id=OLD.case_id) THEN RETURN NEW; END IF; RAISE EXCEPTION 'Correction audit is immutable' USING ERRCODE='23514'; END; $$;
DROP TRIGGER immutable_correction_event ON correction_event;
CREATE TRIGGER immutable_correction_event BEFORE UPDATE ON correction_event FOR EACH ROW EXECUTE FUNCTION protect_correction_event();

-- Object routing must be verified before an empty listing can count as deletion evidence.
CREATE TABLE object_binding (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,storage_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id)
);
CREATE TRIGGER immutable_object_binding BEFORE UPDATE ON object_binding FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
