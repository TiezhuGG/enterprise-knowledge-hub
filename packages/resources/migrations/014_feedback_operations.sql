CREATE TABLE feedback_case (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kb_id uuid NOT NULL,reporter_id uuid NOT NULL,run_id uuid,
 question text NOT NULL,description text NOT NULL,question_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('missing','outdated','retrieval','answer','permission','other')),
 priority text NOT NULL CHECK(priority IN ('normal','high')),status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','triaged','in_progress','awaiting_validation','resolved','dismissed','duplicate')),
 triaged_by uuid,triaged_at timestamptz,assignee_id uuid,duplicate_of uuid,internal_note text,correction_id uuid,resolution_document_id uuid,regression_id uuid,experiment_id uuid,closure_evidence jsonb,
 row_version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,
 content_expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',content_purged_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),FOREIGN KEY(tenant_id,reporter_id) REFERENCES membership(tenant_id,id),
 FOREIGN KEY(tenant_id,assignee_id) REFERENCES membership(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES chat_run(tenant_id,id),FOREIGN KEY(tenant_id,duplicate_of) REFERENCES feedback_case(tenant_id,id),
 CHECK(priority<>'high' OR assignee_id IS NOT NULL)
);
CREATE TABLE feedback_reference (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,generation_id uuid,origin text NOT NULL DEFAULT 'reported' CHECK(origin IN ('reported','remediation')),
 PRIMARY KEY(tenant_id,case_id,document_id,version_id),FOREIGN KEY(tenant_id,case_id) REFERENCES feedback_case(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES document_version(tenant_id,document_id,id)
);
CREATE TRIGGER immutable_feedback_reference BEFORE UPDATE ON feedback_reference FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE INDEX feedback_by_document ON feedback_reference(tenant_id,document_id);
CREATE INDEX feedback_queue ON feedback_case(tenant_id,kb_id,status,created_at,id);
CREATE INDEX feedback_repeat ON feedback_case(tenant_id,kb_id,question_hash);
CREATE TABLE feedback_regression (
 tenant_id uuid NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,reviewer_id uuid NOT NULL,question_hash text NOT NULL,expected_document_ids uuid[] NOT NULL,review_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES feedback_case(tenant_id,id)
);
CREATE TRIGGER immutable_feedback_regression BEFORE UPDATE ON feedback_regression FOR EACH ROW EXECUTE FUNCTION immutable_parsed_output();
CREATE TABLE feedback_event (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,seq integer NOT NULL,member_id uuid NOT NULL,action text NOT NULL,status text NOT NULL,note text NOT NULL,
 content_purged_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,case_id,seq),FOREIGN KEY(tenant_id,case_id) REFERENCES feedback_case(tenant_id,id)
);
CREATE TABLE feedback_request (
 tenant_id uuid NOT NULL,member_id uuid NOT NULL,key_hash text NOT NULL,payload_hash text NOT NULL,case_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,member_id,key_hash)
);
-- Read permissions mirror role/KB/document intersection; this helper never changes ACLs.
CREATE FUNCTION feedback_resource_action(t uuid,k uuid,d uuid,m uuid,act text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM membership p JOIN tenant w ON w.id=p.tenant_id JOIN knowledge_base b ON b.tenant_id=p.tenant_id AND b.id=k
 WHERE p.tenant_id=t AND p.id=m AND p.status='active' AND w.status='active' AND b.status='active'
 AND (act IN ('read','download') OR p.role IN ('operator','admin'))
 AND EXISTS(SELECT 1 FROM acl_entry a WHERE a.tenant_id=t AND a.kb_id=k AND act=ANY(a.actions) AND (a.member_id=m OR EXISTS(SELECT 1 FROM group_member g WHERE g.tenant_id=t AND g.group_id=a.group_id AND g.member_id=m)))
 AND (d IS NULL OR EXISTS(SELECT 1 FROM document x WHERE x.tenant_id=t AND x.id=d AND x.kb_id=k AND x.status<>'deleted'
 AND (x.acl_mode='inherit' OR EXISTS(SELECT 1 FROM acl_entry a WHERE a.tenant_id=t AND a.document_id=d AND act=ANY(a.actions) AND (a.member_id=m OR EXISTS(SELECT 1 FROM group_member g WHERE g.tenant_id=t AND g.group_id=a.group_id AND g.member_id=m)))))))
$$;
CREATE FUNCTION feedback_case_readable(t uuid,c uuid,m uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM feedback_case f WHERE f.tenant_id=t AND f.id=c AND f.content_purged_at IS NULL AND f.content_expires_at>clock_timestamp()
 AND feedback_resource_action(t,f.kb_id,NULL,m,'read')
 AND (f.run_id IS NULL OR EXISTS(SELECT 1 FROM chat_run r JOIN conversation v ON v.tenant_id=r.tenant_id AND v.id=r.conversation_id WHERE r.tenant_id=t AND r.id=f.run_id AND r.content_purged_at IS NULL AND r.content_expires_at>clock_timestamp() AND v.deleted_at IS NULL))
 AND NOT EXISTS(SELECT 1 FROM feedback_reference ref WHERE ref.tenant_id=t AND ref.case_id=c AND NOT EXISTS(
 SELECT 1 FROM document d JOIN document_version dv ON dv.tenant_id=d.tenant_id AND dv.document_id=d.id JOIN source_asset a ON a.tenant_id=dv.tenant_id AND a.id=dv.source_asset_id
 WHERE d.tenant_id=t AND d.id=ref.document_id AND dv.id=ref.version_id AND d.kb_id=f.kb_id AND feedback_resource_action(t,f.kb_id,d.id,m,'read') AND source_document_readable(t,d.id,m)
 AND (d.status='active' OR feedback_resource_action(t,f.kb_id,d.id,m,'write') OR feedback_resource_action(t,f.kb_id,d.id,m,'publish') OR feedback_resource_action(t,f.kb_id,d.id,m,'manage'))
 AND (feedback_resource_action(t,f.kb_id,d.id,m,'write') OR feedback_resource_action(t,f.kb_id,d.id,m,'publish') OR (d.published_version_id=dv.id AND a.scan_status='clean')))))
$$;
CREATE FUNCTION feedback_purge_due(t uuid,c uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM feedback_case f WHERE f.tenant_id=t AND f.id=c AND (f.content_expires_at<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM feedback_reference r JOIN document_tombstone d ON d.tenant_id=r.tenant_id AND d.document_id=r.document_id WHERE r.tenant_id=t AND r.case_id=c)
 OR (f.run_id IS NOT NULL AND EXISTS(SELECT 1 FROM chat_run r JOIN conversation v ON v.tenant_id=r.tenant_id AND v.id=r.conversation_id WHERE r.tenant_id=t AND r.id=f.run_id AND (r.content_purged_at IS NOT NULL OR r.content_expires_at<=clock_timestamp() OR v.deleted_at IS NOT NULL)))))
$$;
CREATE FUNCTION protect_feedback_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND NEW.question='[内容已清理]' AND NEW.description='[内容已清理]' AND NEW.internal_note IS NULL AND feedback_purge_due(OLD.tenant_id,OLD.id) AND (to_jsonb(OLD)-ARRAY['question','description','internal_note','content_purged_at','row_version','updated_at'])=(to_jsonb(NEW)-ARRAY['question','description','internal_note','content_purged_at','row_version','updated_at']) THEN RETURN NEW;END IF;
 IF (OLD.tenant_id,OLD.id,OLD.kb_id,OLD.reporter_id,OLD.run_id,OLD.question,OLD.description,OLD.question_hash,OLD.created_at,OLD.content_expires_at,OLD.content_purged_at) IS DISTINCT FROM (NEW.tenant_id,NEW.id,NEW.kb_id,NEW.reporter_id,NEW.run_id,NEW.question,NEW.description,NEW.question_hash,NEW.created_at,NEW.content_expires_at,NEW.content_purged_at) OR NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Feedback origin is immutable';END IF;RETURN NEW;END;$$;
CREATE TRIGGER frozen_feedback_origin BEFORE UPDATE ON feedback_case FOR EACH ROW EXECUTE FUNCTION protect_feedback_origin();
CREATE FUNCTION protect_feedback_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.content_purged_at IS NULL AND NEW.content_purged_at IS NOT NULL AND NEW.note='[内容已清理]' AND (to_jsonb(OLD)-ARRAY['note','content_purged_at'])=(to_jsonb(NEW)-ARRAY['note','content_purged_at']) AND EXISTS(SELECT 1 FROM feedback_case f WHERE f.tenant_id=OLD.tenant_id AND f.id=OLD.case_id AND f.content_purged_at IS NOT NULL) THEN RETURN NEW;END IF;RAISE EXCEPTION 'Feedback event is immutable';END;$$;
CREATE TRIGGER immutable_feedback_event BEFORE UPDATE ON feedback_event FOR EACH ROW EXECUTE FUNCTION protect_feedback_event();
CREATE FUNCTION purge_feedback_content(t uuid,d uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$ DECLARE n integer;BEGIN
 UPDATE feedback_case f SET question='[内容已清理]',description='[内容已清理]',internal_note=NULL,content_purged_at=now(),row_version=row_version+1,updated_at=now()
 WHERE f.tenant_id=t AND f.content_purged_at IS NULL AND feedback_purge_due(t,f.id) AND (d IS NULL OR EXISTS(SELECT 1 FROM feedback_reference r WHERE r.tenant_id=t AND r.case_id=f.id AND r.document_id=d));GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE feedback_event e SET note='[内容已清理]',content_purged_at=now() FROM feedback_case f WHERE e.tenant_id=t AND f.tenant_id=e.tenant_id AND f.id=e.case_id AND f.content_purged_at IS NOT NULL AND e.content_purged_at IS NULL;RETURN n;END;$$;
