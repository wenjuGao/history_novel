import 'server-only'

import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { applyAddedColumns } from './schema-columns.mjs'
import { applyEvidenceReviewMigration } from './migrations/007-evidence-review.mjs'
import { applyApprovalLimitsMigration } from './migrations/011-approval-limits.mjs'

const globalForDb = globalThis as typeof globalThis & {
	historyNovelDb?: Database.Database
}

function initializeDatabase() {
	const dataDirectory = process.env.HISTORY_DATA_DIR || path.join(process.cwd(), 'data', 'local')
	mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })

	const database = new Database(path.join(dataDirectory, 'workspace.sqlite'))
	database.pragma('journal_mode = WAL')
	database.pragma('foreign_keys = ON')
	// 写锁竞争（BEGIN IMMEDIATE 与后台流式任务并发）先等待而不是直接抛 SQLITE_BUSY。
	database.pragma('busy_timeout = 5000')
	return database
}

function ensureSchema(database: Database.Database) {
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/001-initial.sql'), 'utf8'))

	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/002-creative-setup.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/003-story-workflow.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/004-generation-attempts.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/005-plot-events.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/006-corpus-source.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/008-project-reference-spec.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/009-plot-proposals.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/010-chapter-state.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/012-draft-backups.sql'), 'utf8'))
	database.exec(readFileSync(path.join(process.cwd(), 'src/lib/migrations/013-corpus-years.sql'), 'utf8'))
	applyAddedColumns(database)
	applyEvidenceReviewMigration(database)
	applyApprovalLimitsMigration(database)

	return database
}

export const db = globalForDb.historyNovelDb ?? initializeDatabase()
ensureSchema(db)

if (process.env.NODE_ENV !== 'production') {
	globalForDb.historyNovelDb = db
}
