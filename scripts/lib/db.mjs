import Database from 'better-sqlite3'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { applyAddedColumns } from '../../src/lib/schema-columns.mjs'
import { applyEvidenceReviewMigration } from '../../src/lib/migrations/007-evidence-review.mjs'

const root = process.cwd()
const migrationDirectory = path.join(root, 'src/lib/migrations')

// Applies the same ordered migration set the server uses, without importing the server-only module.
export function openDatabase() {
	const dataDirectory = process.env.HISTORY_DATA_DIR || path.join(root, 'data', 'local')
	mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
	const database = new Database(path.join(dataDirectory, 'workspace.sqlite'))
	database.pragma('journal_mode = WAL')
	database.pragma('foreign_keys = ON')
	for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
		database.exec(readFileSync(path.join(migrationDirectory, file), 'utf8'))
	}
	applyAddedColumns(database)
	applyEvidenceReviewMigration(database)
	return { database, dataDirectory }
}

export { applyAddedColumns }
