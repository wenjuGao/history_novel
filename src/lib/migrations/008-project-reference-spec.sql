-- T051 作品写作规格版本：固定参考小说后，登记规格派生为作品级草稿，作者可编辑并确认；
-- 大纲与正文只使用已确认版本。参考小说原文永远不进入本表或任何生成上下文。
CREATE TABLE IF NOT EXISTS project_reference_spec (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  spec_text TEXT NOT NULL,
  methods_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'registered',
  base_spec_sha256 TEXT NOT NULL DEFAULT '',
  source_combined_sha256 TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, version)
);
-- 旧作品回填：固定时的登记规格落为作品规格 v1 并视为已确认，保持既有行为（幂等）。
INSERT OR IGNORE INTO project_reference_spec(project_id, version, spec_text, methods_json, origin, base_spec_sha256, source_combined_sha256, confirmed_at, created_at)
SELECT p.project_id, 1, s.spec_text, s.methods_json, 'registered', p.spec_sha256, p.combined_sha256, p.pinned_at, p.pinned_at
FROM project_reference p JOIN reference_spec s ON s.spec_sha256 = p.spec_sha256;
