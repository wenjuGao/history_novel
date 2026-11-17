-- T053 已确认故事状态（REQ-026、REQ-027）：只有被人工接受的章节才固化成状态，供后续章节按叙述顺序消费。
-- 状态含摘要、人物所在地与关系、视角知识边界与未收束伏笔，并记录当时正文的输入哈希与规格版本；
-- 前文变更时后续状态改标 'stale'（不进新请求，也不删除），旧文本与旧状态都原样保留供回看。
CREATE TABLE IF NOT EXISTS chapter_states (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_title TEXT NOT NULL DEFAULT '',
  draft_input_hash TEXT NOT NULL,
  spec_version INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  locations_json TEXT NOT NULL DEFAULT '[]',
  relations_json TEXT NOT NULL DEFAULT '[]',
  knowledge_json TEXT NOT NULL DEFAULT '[]',
  threads_json TEXT NOT NULL DEFAULT '[]',
  body_tail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'stale')),
  stale_reason TEXT,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, plan_version, chapter_id)
);

CREATE INDEX IF NOT EXISTS chapter_states_plan_idx
  ON chapter_states (project_id, plan_version, status);
