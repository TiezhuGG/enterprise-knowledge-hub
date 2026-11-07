ALTER TABLE ingestion_job ADD COLUMN indexing_profile_hash text;
ALTER TABLE ingestion_job ADD COLUMN index_build_revision integer NOT NULL DEFAULT 1;
ALTER TABLE ingestion_checkpoint DROP CONSTRAINT ingestion_checkpoint_step_check;
ALTER TABLE ingestion_checkpoint ADD CONSTRAINT ingestion_checkpoint_step_check CHECK(step IN ('source_integrity','parse_structure','chunk_structure','dense_index'));
CREATE TABLE embedding_profile (
 hash text PRIMARY KEY CHECK(length(hash)=64),model text NOT NULL,revision text NOT NULL,dimension integer NOT NULL CHECK(dimension BETWEEN 2 AND 4096),processing text NOT NULL,query_prefix text NOT NULL,document_prefix text NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_embedding_profile BEFORE UPDATE ON embedding_profile FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TABLE embedding_entry (
 tenant_id uuid NOT NULL,profile_hash text NOT NULL REFERENCES embedding_profile(hash),text_sha256 text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','building','ready','unknown')),owner_token uuid,request_id text,lease_until timestamptz,
 vector real[],created_at timestamptz(3) NOT NULL DEFAULT now(),updated_at timestamptz(3) NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,profile_hash,text_sha256),CHECK((status='ready')=(vector IS NOT NULL))
);
CREATE TABLE embedding_request (
 tenant_id uuid NOT NULL,profile_hash text NOT NULL REFERENCES embedding_profile(hash),id text NOT NULL,status text NOT NULL CHECK(status IN ('building','ready','rejected','unknown')),input_count integer NOT NULL,input_characters integer NOT NULL,tokens bigint,created_at timestamptz(3) NOT NULL DEFAULT now(),ended_at timestamptz(3),PRIMARY KEY(tenant_id,id)
);
ALTER TABLE chunk_manifest ADD CONSTRAINT chunk_artifact_identity UNIQUE(tenant_id,version_id,parser_version,chunker_version,artifact_sha256);
CREATE TABLE index_generation (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,generation_no integer NOT NULL,build_revision integer NOT NULL,profile_hash text NOT NULL REFERENCES embedding_profile(hash),
 parser_version text NOT NULL,chunker_version text NOT NULL,chunk_artifact_sha256 text NOT NULL,config_hash text NOT NULL,collection_name text NOT NULL,required_artifacts jsonb NOT NULL DEFAULT '["dense"]' CHECK(required_artifacts='["dense"]'::jsonb),
 status text NOT NULL CHECK(status IN ('building','ready','failed','cancelled')),chunk_count integer NOT NULL,indexed_count integer NOT NULL DEFAULT 0,cache_hits integer NOT NULL DEFAULT 0,provider_inputs integer NOT NULL DEFAULT 0,tokens bigint,created_at timestamptz(3) NOT NULL DEFAULT now(),ready_at timestamptz(3),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,version_id,profile_hash,chunk_artifact_sha256,build_revision),UNIQUE(tenant_id,version_id,generation_no),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,version_id,parser_version,chunker_version) REFERENCES chunk_manifest(tenant_id,version_id,parser_version,chunker_version),
 FOREIGN KEY(tenant_id,version_id,parser_version,chunker_version,chunk_artifact_sha256) REFERENCES chunk_manifest(tenant_id,version_id,parser_version,chunker_version,artifact_sha256)
);
CREATE FUNCTION frozen_index_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.tenant_id,OLD.id,OLD.kb_id,OLD.document_id,OLD.generation_no,OLD.parser_version,OLD.chunker_version,OLD.chunk_count,OLD.version_id,OLD.build_revision,OLD.profile_hash,OLD.chunk_artifact_sha256,OLD.config_hash,OLD.collection_name,OLD.required_artifacts) IS DISTINCT FROM (NEW.tenant_id,NEW.id,NEW.kb_id,NEW.document_id,NEW.generation_no,NEW.parser_version,NEW.chunker_version,NEW.chunk_count,NEW.version_id,NEW.build_revision,NEW.profile_hash,NEW.chunk_artifact_sha256,NEW.config_hash,NEW.collection_name,NEW.required_artifacts) THEN RAISE EXCEPTION 'Index configuration is immutable' USING ERRCODE='23514'; END IF;RETURN NEW;END; $$;
CREATE TRIGGER frozen_index_generation BEFORE UPDATE ON index_generation FOR EACH ROW EXECUTE FUNCTION frozen_index_config();
CREATE TABLE index_receipt (
 tenant_id uuid NOT NULL,generation_id uuid NOT NULL,chunk_id uuid NOT NULL,retrieval_sha256 text NOT NULL,verified_at timestamptz(3) NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,generation_id,chunk_id),FOREIGN KEY(tenant_id,generation_id) REFERENCES index_generation(tenant_id,id),FOREIGN KEY(tenant_id,chunk_id) REFERENCES knowledge_chunk(tenant_id,id)
);
CREATE TABLE index_operation (
 tenant_id uuid NOT NULL,version_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,profile_hash text NOT NULL,run_no integer NOT NULL,PRIMARY KEY(tenant_id,version_id,member_id,key_hash)
);

CREATE TRIGGER immutable_index_receipt BEFORE UPDATE ON index_receipt FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE FUNCTION immutable_ready_embedding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='ready' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Cached embeddings are immutable' USING ERRCODE='23514'; END IF;RETURN NEW;END; $$;
CREATE TRIGGER immutable_ready_embedding BEFORE UPDATE ON embedding_entry FOR EACH ROW EXECUTE FUNCTION immutable_ready_embedding();

ALTER TABLE ingestion_checkpoint ADD COLUMN generation_id uuid;
ALTER TABLE ingestion_checkpoint ADD CONSTRAINT checkpoint_generation FOREIGN KEY(tenant_id,generation_id) REFERENCES index_generation(tenant_id,id);
