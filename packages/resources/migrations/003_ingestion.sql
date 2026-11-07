CREATE TABLE ingestion_job (
  tenant_id uuid NOT NULL, id uuid NOT NULL, kb_id uuid NOT NULL, document_id uuid NOT NULL, version_id uuid NOT NULL,
  outbox_id uuid NOT NULL REFERENCES document_outbox(id), owner_id uuid NOT NULL, executor_id uuid NOT NULL,
  pipeline_version text NOT NULL DEFAULT 'intake-v1' CHECK(pipeline_version='intake-v1'),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry_wait','waiting_dependency','succeeded','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued', error_code text, dead_letter boolean NOT NULL DEFAULT false,
  run_no integer NOT NULL DEFAULT 1, attempt_count integer NOT NULL DEFAULT 0, total_attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  dispatch_revision integer NOT NULL DEFAULT 0, last_enqueued_at timestamptz(3), next_run_at timestamptz(3) NOT NULL DEFAULT now(),
  lease_token uuid, worker_id uuid, lease_until timestamptz(3), deadline_at timestamptz(3), heartbeat_at timestamptz(3),
  cancel_requested_at timestamptz(3), event_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,version_id,pipeline_version),
  FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id),
  FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES membership(tenant_id,id),
  FOREIGN KEY(tenant_id,executor_id) REFERENCES membership(tenant_id,id),
  CHECK((status='running')=(lease_token IS NOT NULL)),
  CHECK(attempt_count>=0 AND total_attempts>=attempt_count),
  CHECK(NOT dead_letter OR status='failed'),
  CHECK(status<>'running' OR (lease_until IS NOT NULL AND deadline_at IS NOT NULL AND worker_id IS NOT NULL))
);
CREATE INDEX ingestion_dispatch ON ingestion_job(status,next_run_at,last_enqueued_at);
CREATE TABLE ingestion_attempt (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, run_no integer NOT NULL, attempt_no integer NOT NULL,
  lease_token uuid NOT NULL UNIQUE, worker_id uuid NOT NULL, executor_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed','failed','interrupted','cancelled')),
  error_code text, started_at timestamptz(3) NOT NULL DEFAULT now(), ended_at timestamptz(3),
  PRIMARY KEY(tenant_id,job_id,run_no,attempt_no), FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
CREATE TABLE ingestion_checkpoint (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, step text NOT NULL CHECK(step='source_integrity'),
  input_sha256 text NOT NULL, completed_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,job_id,step), FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
CREATE TABLE ingestion_event (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, seq integer NOT NULL, run_no integer NOT NULL,
  status text NOT NULL, stage text NOT NULL, error_code text, occurred_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,job_id,seq), FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
CREATE TABLE ingestion_dead_letter (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, run_no integer NOT NULL, error_code text NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT now(), resolved_at timestamptz(3),
  PRIMARY KEY(tenant_id,job_id,run_no), FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
CREATE TABLE ingestion_operation (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, member_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('retry','cancel')),
  key_hash text NOT NULL, payload_hash text NOT NULL, run_no integer NOT NULL,
  PRIMARY KEY(tenant_id,job_id,member_id,action,key_hash), FOREIGN KEY(tenant_id,job_id) REFERENCES ingestion_job(tenant_id,id)
);
-- Materialize existing P1-04 versions without changing original documents or publishing them.
INSERT INTO ingestion_job(tenant_id,id,kb_id,document_id,version_id,outbox_id,owner_id,executor_id)
SELECT v.tenant_id,gen_random_uuid(),d.kb_id,v.document_id,v.id,o.id,v.created_by,v.created_by
FROM document_version v JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
JOIN document_outbox o ON o.tenant_id=v.tenant_id AND o.version_id=v.id;

INSERT INTO ingestion_event(tenant_id,job_id,seq,run_no,status,stage) SELECT tenant_id,id,1,1,'queued','queued' FROM ingestion_job;
UPDATE ingestion_job SET event_seq=1;
