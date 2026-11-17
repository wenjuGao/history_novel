CREATE TABLE IF NOT EXISTS story_plans (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	plan_json TEXT NOT NULL,
	plan_hash TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_plan_revisions (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	plan_json TEXT NOT NULL,
	plan_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY(project_id, version)
);

CREATE TABLE IF NOT EXISTS story_plan_approvals (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	plan_version INTEGER NOT NULL,
	plan_hash TEXT NOT NULL,
	budget_cny REAL NOT NULL CHECK(budget_cny > 0),
	allow_external_transfer INTEGER NOT NULL CHECK(allow_external_transfer IN (0, 1)),
	approved_at TEXT NOT NULL,
	PRIMARY KEY(project_id, plan_version)
);

CREATE TABLE IF NOT EXISTS chapter_drafts (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	plan_version INTEGER NOT NULL,
	plan_hash TEXT NOT NULL,
	chapter_id TEXT NOT NULL,
	chapter_title TEXT NOT NULL,
	content TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK(status IN ('generating', 'draft', 'accepted', 'failed-or-unknown')),
	request_id TEXT,
	input_hash TEXT NOT NULL,
	estimated_cost_cny REAL NOT NULL DEFAULT 0,
	actual_cost_cny REAL,
	prompt_tokens INTEGER,
	completion_tokens INTEGER,
	error_message TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY(project_id, plan_version, chapter_id)
);

CREATE INDEX IF NOT EXISTS chapter_drafts_project_status_idx
	ON chapter_drafts(project_id, plan_version, status);