-- REQ-004、REQ-052 的人物候选须展示生卒与主要事迹，REQ-055 的事件候选须是史料中的真实记事。
-- corpus_person 只有提及次数与一段证据，没有任何人物级年份，因此把「可定年的史料记事」先离线解析成表，
-- 范围与史料步骤只做查询，不在保存时生成数据（见 scripts/index-corpus-years.mjs）。
CREATE TABLE IF NOT EXISTS corpus_entry (
  entry_key TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES corpus_book(book_id) ON DELETE CASCADE,
  volume_name TEXT NOT NULL,
  year_astronomical INTEGER NOT NULL,
  year_label TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  has_death INTEGER NOT NULL DEFAULT 0 CHECK(has_death IN (0, 1)),
  year_precision TEXT NOT NULL DEFAULT 'exact' CHECK(year_precision IN ('exact', 'approx')),
  source_url TEXT NOT NULL DEFAULT '',
  indexed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS corpus_entry_year_idx
  ON corpus_entry(book_id, year_astronomical, sequence);

-- 条目与人名的倒排：事件候选要按「时间 ∩ 本项目已选人物」查询，靠 LIKE 扫正文不可接受。
CREATE TABLE IF NOT EXISTS corpus_entry_person (
  entry_key TEXT NOT NULL REFERENCES corpus_entry(entry_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_death INTEGER NOT NULL DEFAULT 0 CHECK(is_death IN (0, 1)),
  PRIMARY KEY(entry_key, name)
);

CREATE INDEX IF NOT EXISTS corpus_entry_person_name_idx
  ON corpus_entry_person(name, entry_key);

-- 人物年份档案：由带年纪事聚合而来的预处理产物，逐条待人工核对，不构成史实断言。
-- first_year/last_year 为最密记事窗口给出的活动区间（后世追述不计入）；卒年取「人名后紧跟薨/殂/卒/誅」的记事；
-- 生年只接受「年若干歲」这类可换算的显式记载，否则留 NULL 并在界面显示「未詳」。
CREATE TABLE IF NOT EXISTS corpus_person_profile (
  name TEXT PRIMARY KEY,
  birth_year INTEGER,
  birth_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(birth_precision IN ('exact', 'approx', 'unknown')),
  death_year INTEGER,
  death_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(death_precision IN ('exact', 'approx', 'unknown')),
  first_year INTEGER,
  last_year INTEGER,
  -- 活动区间取最密簇；簇外的条数与是否修剪写清楚，界面据此标「推定」而不是当作史实。
  later_mentions INTEGER NOT NULL DEFAULT 0,
  interval_trimmed INTEGER NOT NULL DEFAULT 0 CHECK(interval_trimmed IN (0, 1)),
  entry_count INTEGER NOT NULL DEFAULT 0,
  deeds TEXT NOT NULL DEFAULT '[]',
  year_source TEXT NOT NULL DEFAULT 'anchor' CHECK(year_source IN ('anchor', 'model', 'mixed')),
  needs_review INTEGER NOT NULL DEFAULT 1 CHECK(needs_review IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS corpus_person_profile_span_idx
  ON corpus_person_profile(first_year, last_year);
