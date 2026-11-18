-- REQ-060 正文重新生成前的整行归档：一次调用只重写一章，旧正文在覆盖前原样存到这里，不静默丢字。
-- 只追加不改写，归档行不带状态机；界面按 (project, plan_version, chapter) 倒序取最近一份供对照与恢复。
CREATE TABLE IF NOT EXISTS chapter_draft_backups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  meta_json TEXT,
  status TEXT NOT NULL,
  input_hash TEXT,
  request_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chapter_draft_backups_chapter_idx
  ON chapter_draft_backups (project_id, plan_version, chapter_id, archived_at DESC);
