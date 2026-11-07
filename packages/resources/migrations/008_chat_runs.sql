CREATE TABLE conversation (
 tenant_id uuid NOT NULL, id uuid NOT NULL, member_id uuid NOT NULL, title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 100),
 idempotency_hash text NOT NULL, payload_hash text NOT NULL, row_version integer NOT NULL DEFAULT 1,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,member_id), UNIQUE(tenant_id,member_id,idempotency_hash),
 FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE INDEX conversation_page ON conversation(tenant_id,member_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE chat_run (
 tenant_id uuid NOT NULL, id uuid NOT NULL, conversation_id uuid NOT NULL, member_id uuid NOT NULL,
 question_message_id uuid NOT NULL, message_id uuid NOT NULL, parent_run_id uuid,
 idempotency_hash text NOT NULL,payload_hash text NOT NULL,input jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),stage text NOT NULL,
 dependencies jsonb NOT NULL DEFAULT '[]', result jsonb, error_code text,
 last_event_id integer NOT NULL DEFAULT 0, cancel_requested_at timestamptz,
 deadline_at timestamptz NOT NULL DEFAULT now()+interval '95 seconds', created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,member_id,idempotency_hash),
 FOREIGN KEY(tenant_id,conversation_id,member_id) REFERENCES conversation(tenant_id,id,member_id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_run_id) REFERENCES chat_run(tenant_id,id),
 CHECK((status='running')=(finished_at IS NULL))
);
CREATE UNIQUE INDEX chat_one_active_conversation ON chat_run(tenant_id,conversation_id) WHERE status='running';
CREATE INDEX chat_messages ON chat_run(tenant_id,conversation_id,created_at,id);
CREATE TABLE chat_event (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,seq integer NOT NULL,type text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,seq),FOREIGN KEY(tenant_id,run_id) REFERENCES chat_run(tenant_id,id),
 CHECK(type IN ('run.started','run.progress','citation.upsert','answer.delta','run.completed','run.failed','run.cancelled'))
);
CREATE TABLE chat_feedback (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,member_id uuid NOT NULL,value text NOT NULL CHECK(value IN ('helpful','unhelpful')),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,member_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES chat_run(tenant_id,id),FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE TABLE chat_stream_lease (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,id uuid NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
-- Executed calls are never silently retried after process loss. Terminal results/events are append-only.
CREATE FUNCTION frozen_chat_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'running' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Chat terminal is immutable' USING ERRCODE='23514'; END IF;
 IF (OLD.tenant_id,OLD.id,OLD.conversation_id,OLD.member_id,OLD.input,OLD.payload_hash,OLD.idempotency_hash,OLD.message_id,OLD.question_message_id,OLD.parent_run_id,OLD.created_at) IS DISTINCT FROM (NEW.tenant_id,NEW.id,NEW.conversation_id,NEW.member_id,NEW.input,NEW.payload_hash,NEW.idempotency_hash,NEW.message_id,NEW.question_message_id,NEW.parent_run_id,NEW.created_at) THEN RAISE EXCEPTION 'Chat identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER frozen_chat_terminal BEFORE UPDATE ON chat_run FOR EACH ROW EXECUTE FUNCTION frozen_chat_terminal();
CREATE TRIGGER immutable_chat_event BEFORE UPDATE ON chat_event FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
