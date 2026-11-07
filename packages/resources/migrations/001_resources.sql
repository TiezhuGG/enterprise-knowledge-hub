CREATE TABLE tenant (
  id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);
CREATE TABLE membership (
  tenant_id uuid NOT NULL REFERENCES tenant(id), id uuid NOT NULL, actor_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('employee','operator','admin','auditor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  can_create_kb boolean NOT NULL DEFAULT false, authz_version integer NOT NULL DEFAULT 1 CHECK (authz_version > 0),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,actor_id)
);
CREATE TABLE workspace_group (
  tenant_id uuid NOT NULL REFERENCES tenant(id), id uuid NOT NULL, name text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE group_member (
  tenant_id uuid NOT NULL, group_id uuid NOT NULL, member_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,group_id,member_id),
  FOREIGN KEY (tenant_id,group_id) REFERENCES workspace_group(tenant_id,id),
  FOREIGN KEY (tenant_id,member_id) REFERENCES membership(tenant_id,id)
);
CREATE TABLE knowledge_base (
  tenant_id uuid NOT NULL REFERENCES tenant(id), id uuid NOT NULL, owner_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  publish_policy text NOT NULL DEFAULT 'manual' CHECK (publish_policy = 'manual'),
  row_version integer NOT NULL DEFAULT 1, policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,owner_id) REFERENCES membership(tenant_id,id)
);
CREATE INDEX knowledge_base_page ON knowledge_base(tenant_id,created_at DESC,id DESC);
CREATE TABLE document (
  tenant_id uuid NOT NULL, id uuid NOT NULL, kb_id uuid NOT NULL, created_by uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived','deleted')),
  acl_mode text NOT NULL DEFAULT 'inherit' CHECK (acl_mode IN ('inherit','restricted')),
  row_version integer NOT NULL DEFAULT 1, policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES membership(tenant_id,id)
);
CREATE INDEX document_page ON document(tenant_id,kb_id,created_at DESC,id DESC);
CREATE TABLE acl_entry (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  kb_id uuid, document_id uuid, member_id uuid, group_id uuid,
  actions text[] NOT NULL CHECK (cardinality(actions) > 0 AND actions <@ ARRAY['read','download','write','publish','delete','manage','manage_acl']::text[]),
  PRIMARY KEY (tenant_id,id),
  CHECK (num_nonnulls(kb_id,document_id) = 1), CHECK (num_nonnulls(member_id,group_id) = 1),
  FOREIGN KEY (tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES document(tenant_id,id),
  FOREIGN KEY (tenant_id,member_id) REFERENCES membership(tenant_id,id),
  FOREIGN KEY (tenant_id,group_id) REFERENCES workspace_group(tenant_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,kb_id,document_id,member_id,group_id)
);
CREATE INDEX acl_kb ON acl_entry(tenant_id,kb_id);
CREATE INDEX acl_document ON acl_entry(tenant_id,document_id);
CREATE TABLE resource_idempotency (
  tenant_id uuid NOT NULL, member_id uuid NOT NULL, key_hash text NOT NULL, payload_hash text NOT NULL,
  kb_id uuid NOT NULL, expires_at timestamptz(3) NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id,member_id,key_hash),
  FOREIGN KEY (tenant_id,member_id) REFERENCES membership(tenant_id,id),
  FOREIGN KEY (tenant_id,kb_id) REFERENCES knowledge_base(tenant_id,id)
);
CREATE TABLE resource_audit (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id uuid NOT NULL, member_id uuid NOT NULL,
  resource_id uuid NOT NULL, action text NOT NULL, request_id uuid NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT now()
);
