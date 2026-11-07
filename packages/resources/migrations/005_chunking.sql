ALTER TABLE ingestion_job ADD COLUMN chunker_version text NOT NULL DEFAULT 'structure-chunks-v1' CHECK(chunker_version='structure-chunks-v1');
ALTER TABLE ingestion_checkpoint DROP CONSTRAINT ingestion_checkpoint_step_check;
ALTER TABLE ingestion_checkpoint ADD CONSTRAINT ingestion_checkpoint_step_check CHECK(step IN ('source_integrity','parse_structure','chunk_structure'));
ALTER TABLE parsed_document ADD CONSTRAINT parsed_artifact_identity UNIQUE(tenant_id,version_id,parser_version,artifact_sha256);
ALTER TABLE parsed_block ADD CONSTRAINT parsed_block_version_identity UNIQUE(tenant_id,version_id,parser_version,id);
CREATE TABLE chunk_manifest (
 tenant_id uuid NOT NULL,kb_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,
 parser_version text NOT NULL,chunker_version text NOT NULL CHECK(chunker_version='structure-chunks-v1'),
 source_sha256 text NOT NULL,parsed_artifact_sha256 text NOT NULL,artifact_sha256 text NOT NULL,object_key text NOT NULL,object_version text NOT NULL,
 artifact_size integer NOT NULL CHECK(artifact_size BETWEEN 1 AND 20971520),chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 10000),
 policy jsonb NOT NULL,metrics jsonb NOT NULL,warnings jsonb NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version_id,parser_version,chunker_version),UNIQUE(object_key,object_version),
 FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,version_id,source_sha256) REFERENCES document_version(tenant_id,id,content_sha256),
 FOREIGN KEY(tenant_id,version_id,parser_version,parsed_artifact_sha256) REFERENCES parsed_document(tenant_id,version_id,parser_version,artifact_sha256)
);
CREATE TABLE knowledge_chunk (
 tenant_id uuid NOT NULL,version_id uuid NOT NULL,parser_version text NOT NULL,chunker_version text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('text','table','code')),text_sha256 text NOT NULL,retrieval_sha256 text NOT NULL,text_length integer NOT NULL CHECK(text_length>0),
 retrieval_length integer NOT NULL CHECK(retrieval_length BETWEEN 1 AND 1200),heading_path text[] NOT NULL,
 PRIMARY KEY(tenant_id,version_id,parser_version,chunker_version,ordinal),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,version_id,parser_version,chunker_version) REFERENCES chunk_manifest(tenant_id,version_id,parser_version,chunker_version)
);
CREATE TABLE chunk_source (
 tenant_id uuid NOT NULL,version_id uuid NOT NULL,parser_version text NOT NULL,chunker_version text NOT NULL,chunk_ordinal integer NOT NULL,span_ordinal integer NOT NULL CHECK(span_ordinal>=0),
 block_id uuid NOT NULL,start_offset integer NOT NULL CHECK(start_offset>=0),end_offset integer NOT NULL CHECK(end_offset>=start_offset),
 role text NOT NULL CHECK(role IN ('body','table_header')),source jsonb NOT NULL,row_start integer,row_end integer,
 PRIMARY KEY(tenant_id,version_id,parser_version,chunker_version,chunk_ordinal,span_ordinal),
 FOREIGN KEY(tenant_id,version_id,parser_version,chunker_version,chunk_ordinal) REFERENCES knowledge_chunk(tenant_id,version_id,parser_version,chunker_version,ordinal),
 FOREIGN KEY(tenant_id,version_id,parser_version,block_id) REFERENCES parsed_block(tenant_id,version_id,parser_version,id)
);
CREATE TRIGGER immutable_chunk_manifest BEFORE UPDATE ON chunk_manifest FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TRIGGER immutable_knowledge_chunk BEFORE UPDATE ON knowledge_chunk FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TRIGGER immutable_chunk_source BEFORE UPDATE ON chunk_source FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
-- Resume only materialized P1-06 results. Failed/cancelled tasks remain terminal.
WITH resumed AS (
 UPDATE ingestion_job j SET status='queued',stage='queued',run_no=run_no+1,attempt_count=0,last_enqueued_at=NULL,next_run_at=now(),dispatch_revision=dispatch_revision+1,error_code=NULL,event_seq=event_seq+1,updated_at=now()
 WHERE status='waiting_dependency' AND stage='awaiting_chunker' AND error_code='CHUNKER_NOT_CONFIGURED' AND cancel_requested_at IS NULL
 AND EXISTS(SELECT 1 FROM parsed_document p WHERE p.tenant_id=j.tenant_id AND p.version_id=j.version_id AND p.parser_version=j.parser_version)
 RETURNING tenant_id,id,event_seq,run_no,status,stage
) INSERT INTO ingestion_event(tenant_id,job_id,seq,run_no,status,stage) SELECT tenant_id,id,event_seq,run_no,status,stage FROM resumed;
