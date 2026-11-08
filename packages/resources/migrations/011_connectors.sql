CREATE TABLE source_connector (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,owner_id uuid NOT NULL,actor_id uuid NOT NULL,
 config_ref text NOT NULL,config_hash text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','paused','removed')),
 cursor bigint NOT NULL DEFAULT 0,observed_end bigint NOT NULL DEFAULT 0,mapping_hash text,row_version integer NOT NULL DEFAULT 1,
 next_poll_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES membership(tenant_id,id)
);
CREATE UNIQUE INDEX connector_live_source ON source_connector(tenant_id,kb_id,config_ref) WHERE status<>'removed';
CREATE TABLE connector_run (
 tenant_id uuid NOT NULL,id uuid NOT NULL,connector_id uuid NOT NULL,mode text NOT NULL CHECK(mode IN ('incremental','full')),
 status text NOT NULL CHECK(status IN ('queued','running','retry_wait','blocked','failed','succeeded','cancelled')),attempts integer NOT NULL DEFAULT 0,
 worker_token uuid,error_code text,next_run_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 pages integer NOT NULL DEFAULT 0,applied integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,connector_id) REFERENCES source_connector(tenant_id,id)
);
CREATE UNIQUE INDEX connector_one_run ON connector_run(tenant_id,connector_id) WHERE status IN ('queued','running','retry_wait');
CREATE TABLE connector_request (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,resource_id uuid NOT NULL,kind text NOT NULL,
 PRIMARY KEY(tenant_id,member_id,key_hash)
);
CREATE TABLE source_item (
 tenant_id uuid NOT NULL,connector_id uuid NOT NULL,external_id text NOT NULL,document_id uuid,version_id uuid,
 last_seq bigint NOT NULL DEFAULT 0,security_seq bigint NOT NULL DEFAULT 0,revision_hash text,content_sha256 text,
 source_readers text[] NOT NULL DEFAULT '{}',state text NOT NULL CHECK(state IN ('importing','active','revoked','quarantined','deleted')),
 fresh_until timestamptz NOT NULL DEFAULT now(),pending_ticket_id uuid,pending_seq bigint,ticket_generation integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,connector_id,external_id),UNIQUE(tenant_id,document_id),
 FOREIGN KEY(tenant_id,connector_id) REFERENCES source_connector(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES document(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id)
);
CREATE TABLE source_reader (
 tenant_id uuid NOT NULL,connector_id uuid NOT NULL,external_id text NOT NULL,member_id uuid,group_id uuid,
 CHECK(num_nonnulls(member_id,group_id)=1),
 FOREIGN KEY(tenant_id,connector_id,external_id) REFERENCES source_item(tenant_id,connector_id,external_id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id),FOREIGN KEY(tenant_id,group_id) REFERENCES workspace_group(tenant_id,id)
);
CREATE UNIQUE INDEX source_reader_unique ON source_reader(tenant_id,connector_id,external_id,member_id,group_id) NULLS NOT DISTINCT;
CREATE TABLE source_event (
 tenant_id uuid NOT NULL,connector_id uuid NOT NULL,seq bigint NOT NULL,external_id text NOT NULL,digest text NOT NULL,
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','applied','ignored')),created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 PRIMARY KEY(tenant_id,connector_id,seq),FOREIGN KEY(tenant_id,connector_id,external_id) REFERENCES source_item(tenant_id,connector_id,external_id)
);
CREATE TABLE source_page (
 tenant_id uuid NOT NULL,connector_id uuid NOT NULL,start_seq bigint NOT NULL,end_seq bigint NOT NULL,digest text NOT NULL,
 PRIMARY KEY(tenant_id,connector_id,start_seq),FOREIGN KEY(tenant_id,connector_id) REFERENCES source_connector(tenant_id,id)
);
CREATE TABLE connector_event (
 seq bigserial PRIMARY KEY,tenant_id uuid NOT NULL,connector_id uuid NOT NULL,run_id uuid,kind text NOT NULL,error_code text,member_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,connector_id) REFERENCES source_connector(tenant_id,id)
);
CREATE TRIGGER immutable_connector_event BEFORE UPDATE ON connector_event FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE FUNCTION source_document_readable(p_tenant uuid,p_document uuid,p_member uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM source_item s WHERE s.tenant_id=p_tenant AND s.document_id=p_document)
 OR EXISTS(SELECT 1 FROM source_item s JOIN source_connector c ON c.tenant_id=s.tenant_id AND c.id=s.connector_id JOIN document d ON d.tenant_id=s.tenant_id AND d.id=s.document_id
 WHERE s.tenant_id=p_tenant AND s.document_id=p_document AND s.state='active' AND s.fresh_until>clock_timestamp() AND c.status='active'
 AND (d.published_version_id IS NULL OR d.published_version_id=s.version_id)
 AND EXISTS(SELECT 1 FROM source_reader r WHERE r.tenant_id=s.tenant_id AND r.connector_id=s.connector_id AND r.external_id=s.external_id
 AND (r.member_id=p_member OR EXISTS(SELECT 1 FROM group_member g WHERE g.tenant_id=r.tenant_id AND g.group_id=r.group_id AND g.member_id=p_member))))
$$;
