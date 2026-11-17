CREATE TABLE IF NOT EXISTS character_activity (
 character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
 start_year INTEGER NOT NULL, end_year INTEGER NOT NULL, region TEXT NOT NULL,
 CHECK(start_year <= end_year)
);
CREATE TABLE IF NOT EXISTS historical_relations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 from_id TEXT NOT NULL REFERENCES characters(id), to_id TEXT NOT NULL REFERENCES characters(id),
 label TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), evidence TEXT NOT NULL,
 start_year INTEGER NOT NULL, end_year INTEGER NOT NULL,
 CHECK(from_id != to_id), CHECK(start_year <= end_year)
);
CREATE TABLE IF NOT EXISTS fiction_settings (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('人物','关系','对白','心理','日常场景')),
 title TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL
);
