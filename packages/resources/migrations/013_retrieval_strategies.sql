CREATE TABLE retrieval_strategy (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,version_no integer NOT NULL,name text NOT NULL,
 config jsonb NOT NULL,config_hash text NOT NULL,creator_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,kb_id,id),UNIQUE(tenant_id,kb_id,version_no),
 FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),FOREIGN KEY(tenant_id,creator_id) REFERENCES membership(tenant_id,id)
);
CREATE TRIGGER immutable_retrieval_strategy BEFORE UPDATE ON retrieval_strategy FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
ALTER TABLE knowledge_base ADD COLUMN active_strategy_id uuid;
ALTER TABLE knowledge_base ADD CONSTRAINT active_strategy_belongs_to_kb FOREIGN KEY(tenant_id,id,active_strategy_id) REFERENCES retrieval_strategy(tenant_id,kb_id,id);
CREATE TABLE retrieval_experiment (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,member_id uuid NOT NULL,candidate_id uuid NOT NULL,baseline_id uuid,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),error_code text,scope_hash text NOT NULL,baseline_hash text NOT NULL,report jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,kb_id,candidate_id) REFERENCES retrieval_strategy(tenant_id,kb_id,id)
);
CREATE FUNCTION freeze_experiment_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'running' OR NEW.status NOT IN ('completed','failed') OR (to_jsonb(OLD)-ARRAY['status','error_code','report']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','error_code','report']) THEN RAISE EXCEPTION 'Experiment result is immutable';END IF;RETURN NEW;END;$$;
CREATE TRIGGER immutable_retrieval_experiment BEFORE UPDATE ON retrieval_experiment FOR EACH ROW EXECUTE FUNCTION freeze_experiment_result();
CREATE TABLE strategy_request (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,member_id,key_hash)
);
CREATE TABLE strategy_publication (
 seq bigserial PRIMARY KEY,id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,kb_id uuid NOT NULL,member_id uuid NOT NULL,from_id uuid,to_id uuid,experiment_id uuid,review_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_strategy_publication BEFORE UPDATE ON strategy_publication FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
