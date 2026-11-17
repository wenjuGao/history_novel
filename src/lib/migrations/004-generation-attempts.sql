CREATE TABLE IF NOT EXISTS chapter_generation_attempts (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	plan_version INTEGER NOT NULL,
	chapter_id TEXT NOT NULL,
	attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
	request_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'incomplete', 'failed-or-unknown')),
	request_id TEXT,
	prompt_tokens INTEGER,
	completion_tokens INTEGER,
	estimated_cost_cny REAL NOT NULL DEFAULT 0,
	actual_cost_cny REAL,
	error_summary TEXT,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	UNIQUE(project_id, plan_version, chapter_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS chapter_generation_attempts_lookup_idx
	ON chapter_generation_attempts(project_id, plan_version, chapter_id, attempt_number);