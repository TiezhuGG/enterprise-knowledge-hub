CREATE TABLE index_release (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,owner_id uuid NOT NULL,
 profile_ref text NOT NULL,profile_hash text NOT NULL,status text NOT NULL CHECK(status IN ('building','verified','active','rolled_back','cancelled')),
 row_version integer NOT NULL DEFAULT 1,coverage_hash text,proof jsonb,review_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES membership(tenant_id,id)
);
CREATE UNIQUE INDEX one_building_release ON index_release(tenant_id,kb_id) WHERE status IN ('building','verified');
CREATE TABLE index_release_item (
 tenant_id uuid NOT NULL,release_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,
 baseline_generation_id uuid NOT NULL,candidate_generation_id uuid,build_key uuid NOT NULL,error_code text,
 PRIMARY KEY(tenant_id,release_id,document_id),FOREIGN KEY(tenant_id,release_id) REFERENCES index_release(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id)
);
CREATE TABLE publication_request (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,member_id,key_hash)
);
CREATE TABLE publication_event (
 seq bigserial PRIMARY KEY,tenant_id uuid NOT NULL,kb_id uuid NOT NULL,document_id uuid,release_id uuid,member_id uuid NOT NULL,
 action text NOT NULL,from_version_id uuid,from_generation_id uuid,to_version_id uuid,to_generation_id uuid,proof_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_publication_event BEFORE UPDATE ON publication_event FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
ALTER TABLE knowledge_base ADD COLUMN active_index_profile_hash text REFERENCES embedding_profile(hash);
