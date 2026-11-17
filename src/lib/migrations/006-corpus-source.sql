CREATE TABLE IF NOT EXISTS corpus_book (
	book_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	title TEXT NOT NULL,
	category TEXT NOT NULL,
	start_year INTEGER NOT NULL,
	end_year INTEGER NOT NULL,
	coverage_precision TEXT NOT NULL DEFAULT 'approx' CHECK(coverage_precision IN ('approx', 'exact')),
	volume_count INTEGER NOT NULL DEFAULT 0,
	page_count INTEGER NOT NULL DEFAULT 0,
	complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1)),
	report_sha256 TEXT NOT NULL DEFAULT '',
	indexed_at TEXT NOT NULL,
	CHECK(start_year <= end_year)
);

CREATE TABLE IF NOT EXISTS corpus_volume (
	book_id TEXT NOT NULL REFERENCES corpus_book(book_id) ON DELETE CASCADE,
	volume_name TEXT NOT NULL,
	page_key TEXT NOT NULL,
	source_url TEXT NOT NULL,
	oldid TEXT NOT NULL,
	text TEXT NOT NULL,
	text_length INTEGER NOT NULL,
	text_sha256 TEXT NOT NULL,
	raw_html_sha256 TEXT NOT NULL DEFAULT '',
	collected_at TEXT NOT NULL DEFAULT '',
	indexed_at TEXT NOT NULL,
	PRIMARY KEY(book_id, volume_name)
);

CREATE INDEX IF NOT EXISTS corpus_volume_book_idx ON corpus_volume(book_id, volume_name);

CREATE TABLE IF NOT EXISTS corpus_person (
	book_id TEXT NOT NULL REFERENCES corpus_book(book_id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	mentions INTEGER NOT NULL,
	volume_hits INTEGER NOT NULL,
	volumes TEXT NOT NULL DEFAULT '[]',
	evidence TEXT NOT NULL DEFAULT '',
	evidence_volume TEXT NOT NULL DEFAULT '',
	evidence_url TEXT NOT NULL DEFAULT '',
	indexed_at TEXT NOT NULL,
	PRIMARY KEY(book_id, name)
);

CREATE INDEX IF NOT EXISTS corpus_person_mentions_idx ON corpus_person(book_id, mentions DESC);

CREATE TABLE IF NOT EXISTS corpus_person_edge (
	book_id TEXT NOT NULL REFERENCES corpus_book(book_id) ON DELETE CASCADE,
	name_a TEXT NOT NULL,
	name_b TEXT NOT NULL,
	co_mentions INTEGER NOT NULL,
	volumes TEXT NOT NULL DEFAULT '[]',
	evidence TEXT NOT NULL DEFAULT '',
	evidence_volume TEXT NOT NULL DEFAULT '',
	evidence_url TEXT NOT NULL DEFAULT '',
	indexed_at TEXT NOT NULL,
	PRIMARY KEY(book_id, name_a, name_b)
);

CREATE INDEX IF NOT EXISTS corpus_person_edge_pair_idx ON corpus_person_edge(name_a, name_b);

CREATE TABLE IF NOT EXISTS corpus_person_blocks (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY(project_id, name)
);

CREATE TABLE IF NOT EXISTS corpus_state (
	kind TEXT PRIMARY KEY,
	sha256 TEXT NOT NULL DEFAULT '',
	rows INTEGER NOT NULL DEFAULT 0,
	built_at TEXT NOT NULL,
	notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reference_novel (
	source_sha256 TEXT PRIMARY KEY,
	series_key TEXT NOT NULL,
	series TEXT NOT NULL,
	volume TEXT NOT NULL DEFAULT '',
	volume_order INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,
	filename TEXT NOT NULL DEFAULT '',
	characters INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER NOT NULL DEFAULT 0,
	text_path TEXT NOT NULL,
	text_sha256 TEXT NOT NULL DEFAULT '',
	toc_entries INTEGER NOT NULL DEFAULT 0,
	converted_at TEXT NOT NULL DEFAULT '',
	registered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reference_novel_series_idx ON reference_novel(series_key);

CREATE TABLE IF NOT EXISTS reference_spec (
	spec_sha256 TEXT PRIMARY KEY,
	series_key TEXT NOT NULL,
	combined_sha256 TEXT NOT NULL,
	spec_text TEXT NOT NULL,
	methods_json TEXT NOT NULL DEFAULT '[]',
	origin TEXT NOT NULL CHECK(origin IN ('trial', 'model', 'manual')),
	source_path TEXT NOT NULL DEFAULT '',
	generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reference_spec_series_idx ON reference_spec(series_key, combined_sha256);

CREATE TABLE IF NOT EXISTS project_corpus (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	report_sha256 TEXT NOT NULL DEFAULT '',
	books_json TEXT NOT NULL DEFAULT '[]',
	pinned_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_reference (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	series_key TEXT NOT NULL,
	combined_sha256 TEXT NOT NULL,
	spec_sha256 TEXT,
	pinned_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_auto_settings (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	outline_mode TEXT NOT NULL DEFAULT 'model' CHECK(outline_mode IN ('local', 'model', 'off')),
	allow_external_transfer INTEGER NOT NULL DEFAULT 0 CHECK(allow_external_transfer IN (0, 1)),
	token_ceiling INTEGER NOT NULL DEFAULT 0,
	max_characters INTEGER NOT NULL DEFAULT 12 CHECK(max_characters BETWEEN 2 AND 60),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	run_at TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('ok', 'partial', 'failed')),
	input_json TEXT NOT NULL DEFAULT '{}',
	result_json TEXT NOT NULL DEFAULT '{}',
	error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS auto_runs_project_idx ON auto_runs(project_id, run_at DESC);
