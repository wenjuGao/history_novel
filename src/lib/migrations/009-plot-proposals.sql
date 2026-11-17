-- T052 剧情提案：同一组已采用史实上至多三份可编辑提案（slot 1..3），重生成只替换未采用的提案；
-- 提案必须选定后才允许生成章纲，提案与章纲都绑定当时的输入版本哈希（REQ-019、REQ-051、REQ-056）。
-- 被替换的旧版本以 status='superseded' 原样保留，作者可回看草稿；参考小说原文与本表无关。
CREATE TABLE IF NOT EXISTS plot_proposals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  input_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  viewpoint TEXT NOT NULL,
  main_line TEXT NOT NULL,
  synopsis TEXT NOT NULL DEFAULT '',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  fiction_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('local', 'model', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'selected', 'superseded')),
  model_request_id TEXT,
  spec_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slot, revision)
);

CREATE INDEX IF NOT EXISTS plot_proposals_status ON plot_proposals (project_id, status);
