-- Add a publication generation pointer, without publishing any existing version.
ALTER TABLE index_generation ADD CONSTRAINT generation_publication_identity UNIQUE(tenant_id,document_id,version_id,id);
ALTER TABLE document ADD COLUMN published_generation_id uuid;
ALTER TABLE document ADD CONSTRAINT publication_generation_requires_version CHECK(published_generation_id IS NULL OR published_version_id IS NOT NULL);
ALTER TABLE document ADD CONSTRAINT published_generation_identity FOREIGN KEY(tenant_id,id,published_version_id,published_generation_id) REFERENCES index_generation(tenant_id,document_id,version_id,id);
