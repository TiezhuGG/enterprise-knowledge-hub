ALTER TABLE ingestion_job ADD COLUMN parser_version text NOT NULL DEFAULT 'structure-v1' CHECK(parser_version='structure-v1');
ALTER TABLE ingestion_checkpoint DROP CONSTRAINT ingestion_checkpoint_step_check;
ALTER TABLE ingestion_checkpoint ADD CONSTRAINT ingestion_checkpoint_step_check CHECK(step IN ('source_integrity','parse_structure'));
ALTER TABLE ingestion_checkpoint ADD COLUMN processor_version text;
ALTER TABLE document_version ADD CONSTRAINT version_source_identity UNIQUE(tenant_id,id,content_sha256);
CREATE TABLE parsed_document (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL, version_id uuid NOT NULL, parser_version text NOT NULL,
 source_sha256 text NOT NULL, artifact_sha256 text NOT NULL, object_key text NOT NULL, object_version text NOT NULL,
 artifact_size integer NOT NULL CHECK(artifact_size BETWEEN 1 AND 20971520), format text NOT NULL CHECK(format IN ('txt','markdown','pdf','docx')),
 page_count integer CHECK(page_count BETWEEN 1 AND 1000), block_count integer NOT NULL CHECK(block_count BETWEEN 1 AND 50000),
 warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'), metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'),
 created_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,version_id,parser_version), UNIQUE(object_key,object_version),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,version_id,source_sha256) REFERENCES document_version(tenant_id,id,content_sha256)
);
CREATE TABLE parsed_block (
 tenant_id uuid NOT NULL, version_id uuid NOT NULL, parser_version text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('heading','paragraph','list_item','table','code','header','footer')), heading_path text[] NOT NULL,
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'), text_sha256 text NOT NULL, text_length integer NOT NULL CHECK(text_length>=0),
 PRIMARY KEY(tenant_id,version_id,parser_version,ordinal), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,version_id,parser_version) REFERENCES parsed_document(tenant_id,version_id,parser_version)
);
CREATE FUNCTION immutable_parsed_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Parsed outputs are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER immutable_parsed_document BEFORE UPDATE ON parsed_document FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TRIGGER immutable_parsed_block BEFORE UPDATE ON parsed_block FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
-- Resume only the explicit missing-parser dependency. Never resurrect cancelled/failed jobs.
UPDATE ingestion_job SET status='queued',stage='queued',run_no=run_no+1,attempt_count=0,last_enqueued_at=NULL,next_run_at=now(),dispatch_revision=dispatch_revision+1,error_code=NULL,event_seq=event_seq+1,updated_at=now()
WHERE status='waiting_dependency' AND stage='awaiting_parser' AND error_code='PARSER_NOT_CONFIGURED' AND cancel_requested_at IS NULL;
INSERT INTO ingestion_event(tenant_id,job_id,seq,run_no,status,stage)
SELECT tenant_id,id,event_seq,run_no,status,stage FROM ingestion_job j WHERE status='queued' AND run_no>1 AND NOT EXISTS(SELECT 1 FROM ingestion_event e WHERE e.tenant_id=j.tenant_id AND e.job_id=j.id AND e.seq=j.event_seq);
