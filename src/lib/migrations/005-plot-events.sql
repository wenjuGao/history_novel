CREATE TABLE IF NOT EXISTS plot_events (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
	summary TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL CHECK(kind IN ('historical', 'fiction')),
	status TEXT NOT NULL CHECK(status IN ('candidate', 'adopted', 'rejected')),
	origin TEXT NOT NULL CHECK(origin IN ('derived', 'manual')),
	source_key TEXT,
	document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
	evidence TEXT NOT NULL DEFAULT '',
	region TEXT NOT NULL DEFAULT '',
	start_year INTEGER NOT NULL,
	end_year INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK(start_year <= end_year),
	UNIQUE(project_id, source_key)
);

CREATE INDEX IF NOT EXISTS plot_events_project_status_idx
	ON plot_events(project_id, status, start_year, end_year);

CREATE TABLE IF NOT EXISTS plot_event_participants (
	event_id TEXT NOT NULL REFERENCES plot_events(id) ON DELETE CASCADE,
	character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
	participation TEXT NOT NULL DEFAULT '出席' CHECK(participation IN ('主导', '出席', '对立')),
	PRIMARY KEY(event_id, character_id)
);
