CREATE TABLE source_asset (
  tenant_id uuid NOT NULL REFERENCES tenant(id), id uuid NOT NULL,
  object_key text NOT NULL, object_version text NOT NULL,
  size integer NOT NULL CHECK(size>0), mime text NOT NULL, filename text NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  scan_status text NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','rejected')),
  created_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  UNIQUE(object_key,object_version), UNIQUE(tenant_id,id,sha256)
);
CREATE TABLE document_version (
  tenant_id uuid NOT NULL, id uuid NOT NULL, document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK(version_no>0), source_asset_id uuid NOT NULL,
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,document_id,id),
  UNIQUE(tenant_id,document_id,version_no), UNIQUE(tenant_id,document_id,content_sha256),
  FOREIGN KEY(tenant_id,document_id) REFERENCES document(tenant_id,id),
  FOREIGN KEY(tenant_id,source_asset_id,content_sha256) REFERENCES source_asset(tenant_id,id,sha256),
  FOREIGN KEY(tenant_id,created_by) REFERENCES membership(tenant_id,id)
);
ALTER TABLE document ADD COLUMN latest_version_id uuid, ADD COLUMN published_version_id uuid;
ALTER TABLE document ADD FOREIGN KEY(tenant_id,id,latest_version_id) REFERENCES document_version(tenant_id,document_id,id);
ALTER TABLE document ADD FOREIGN KEY(tenant_id,id,published_version_id) REFERENCES document_version(tenant_id,document_id,id);
CREATE FUNCTION immutable_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Document versions are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON document_version FOR EACH ROW EXECUTE FUNCTION immutable_document_version();
CREATE FUNCTION immutable_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.id,NEW.object_key,NEW.object_version,NEW.size,NEW.mime,NEW.filename,NEW.sha256,NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.object_key,OLD.object_version,OLD.size,OLD.mime,OLD.filename,OLD.sha256,OLD.created_at)
  THEN RAISE EXCEPTION 'Source identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_source BEFORE UPDATE ON source_asset FOR EACH ROW EXECUTE FUNCTION immutable_source_identity();
CREATE TABLE upload_ticket (
  tenant_id uuid NOT NULL, id uuid NOT NULL, member_id uuid NOT NULL, kb_id uuid NOT NULL,
  target_document_id uuid, assigned_document_id uuid NOT NULL, base_revision integer,
  filename text NOT NULL, size integer NOT NULL CHECK(size>0), mime text NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE, object_version text,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','uploaded','finalized')),
  expires_at timestamptz(3) NOT NULL, version_id uuid, storage_cleaned_at timestamptz(3),
  idempotency_hash text NOT NULL, payload_hash text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,member_id,idempotency_hash),
  FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id),
  FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),
  FOREIGN KEY(tenant_id,target_document_id) REFERENCES document(tenant_id,id),
  FOREIGN KEY(tenant_id,version_id) REFERENCES document_version(tenant_id,id),
  CHECK(target_document_id IS NULL OR target_document_id=assigned_document_id),
  CHECK((status='finalized')=(version_id IS NOT NULL))
);
CREATE INDEX upload_reservations ON upload_ticket(tenant_id,expires_at) WHERE status<>'finalized';
CREATE TABLE document_outbox (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, document_id uuid NOT NULL, version_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type='document.version_created'), schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(), dispatched_at timestamptz(3),
  UNIQUE(tenant_id,version_id,event_type),
  FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id)
);
