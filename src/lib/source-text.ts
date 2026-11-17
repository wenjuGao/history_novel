import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { db } from '@/lib/db'

// 本地古籍语料即项目的固定历史资料：documents 里为每部书保留一行「空正文 + corpus_ref」，
// 正文只存在 corpus_volume，证据校验用 SQLite 的 instr() 直接在那部书的卷文本里定位。

export type CorpusPinning = {
	reportSha256: string
	books: Array<{ id: string; name: string; volumes: number; startYear: number; endYear: number }>
	pinnedAt: string
	updatedAt: string
}

export type HistorySource = {
	id: string
	title: string
	kind: 'corpus' | 'upload'
	volumes: number
	startYear: number | null
	endYear: number | null
}

function hash(...parts: string[]) {
	return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')
}

export function corpusReady() {
	const row = db.prepare("SELECT sha256, rows FROM corpus_state WHERE kind = 'corpus'").get() as { sha256: string; rows: number } | undefined
	return row && row.rows > 0 ? row : null
}

// 固定 = 全量入库书目写进 project_corpus，并为每部书补一条 history 资料行（幂等，可重复调用）。
export function pinCorpus(projectId: string) {
	const state = corpusReady()
	if (!state) throw new Error('本机古籍语料尚未入库，请先执行 npm run corpus:index。')
	const books = db
		.prepare('SELECT book_id AS id, name, volume_count AS volumes, start_year AS startYear, end_year AS endYear FROM corpus_book ORDER BY start_year')
		.all() as CorpusPinning['books']
	if (!books.length) throw new Error('本机古籍语料尚未入库，请先执行 npm run corpus:index。')
	const now = new Date().toISOString()
	const reportSha256 = state.sha256
	db.transaction(() => {
		db.prepare(
			`INSERT INTO project_corpus(project_id, report_sha256, books_json, pinned_at, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(project_id) DO UPDATE SET report_sha256 = excluded.report_sha256, books_json = excluded.books_json, updated_at = excluded.updated_at`,
		).run(projectId, reportSha256, JSON.stringify(books), now, now)
		for (const book of books) insertCorpusDocument(projectId, book.id, book.name, reportSha256, now)
	})()
	return { reportSha256, books, pinnedAt: now, updatedAt: now } satisfies CorpusPinning
}

function insertCorpusDocument(projectId: string, bookId: string, name: string, reportSha256: string, now: string) {
	const existing = db.prepare('SELECT id FROM documents WHERE project_id = ? AND category = ? AND corpus_ref = ?').get(projectId, 'history', bookId) as
		| { id: string }
		| undefined
	if (existing) {
		db.prepare('UPDATE documents SET title = ?, sha256 = ? WHERE id = ?').run(name, hash('corpus', projectId, bookId, reportSha256), existing.id)
		return existing.id
	}
	const id = randomUUID()
	db.prepare(
		`INSERT INTO documents(id, project_id, category, title, filename, sha256, content, created_at, corpus_ref) VALUES (?, ?, 'history', ?, '', ?, '', ?, ?)`,
	).run(id, projectId, name, hash('corpus', projectId, bookId, reportSha256), now, bookId)
	return id
}

export function corpusPinning(projectId: string): CorpusPinning | null {
	const row = db.prepare('SELECT report_sha256 AS reportSha256, books_json AS booksJson, pinned_at AS pinnedAt, updated_at AS updatedAt FROM project_corpus WHERE project_id = ?').get(projectId) as
		| { reportSha256: string; booksJson: string; pinnedAt: string; updatedAt: string }
		| undefined
	if (!row) return null
	let books: CorpusPinning['books'] = []
	try {
		books = JSON.parse(row.booksJson)
	} catch {
		books = []
	}
	return { reportSha256: row.reportSha256, books, pinnedAt: row.pinnedAt, updatedAt: row.updatedAt }
}

export function historySources(projectId: string): HistorySource[] {
	return db
		.prepare(
			`SELECT d.id, d.title, CASE WHEN d.corpus_ref IS NULL THEN 'upload' ELSE 'corpus' END AS kind,
				COALESCE(b.volume_count, 0) AS volumes, b.start_year AS startYear, b.end_year AS endYear
			 FROM documents d LEFT JOIN corpus_book b ON b.book_id = d.corpus_ref
			 WHERE d.project_id = ? AND d.category = 'history' ORDER BY d.corpus_ref IS NULL, b.start_year, d.created_at`,
		)
		.all(projectId) as HistorySource[]
}

// 证据校验的唯一入口：上传资料比对正文，语料资料在那部书的卷文本里定位并给出卷名。
export function assertEvidenceInSource(projectId: string, documentId: string, evidence: string): { ok: boolean; volumeName?: string } {
	const needle = evidence.trim()
	if (!needle) return { ok: false }
	const source = db
		.prepare("SELECT content, corpus_ref AS corpusRef FROM documents WHERE id = ? AND project_id = ? AND category = 'history'")
		.get(documentId, projectId) as { content: string; corpusRef: string | null } | undefined
	if (!source) return { ok: false }
	if (source.corpusRef) {
		const volume = db.prepare('SELECT volume_name AS volumeName FROM corpus_volume WHERE book_id = ? AND instr(text, ?) > 0 LIMIT 1').get(source.corpusRef, needle) as
			| { volumeName: string }
			| undefined
		return volume ? { ok: true, volumeName: volume.volumeName } : { ok: false }
	}
	return source.content.includes(needle) ? { ok: true } : { ok: false }
}

export function corpusBooksOverlappingScope(startYear: number, endYear: number) {
	return db
		.prepare(
			`SELECT book_id AS id, name, volume_count AS volumes, start_year AS startYear, end_year AS endYear
			 FROM corpus_book WHERE start_year <= ? AND end_year >= ? ORDER BY start_year`,
		)
		.all(endYear, startYear) as Array<{ id: string; name: string; volumes: number; startYear: number; endYear: number }>
}

export function corpusDocumentIds(projectId: string, bookIds: string[]) {
	if (!bookIds.length) return [] as Array<{ id: string; bookId: string }>
	const placeholders = bookIds.map(() => '?').join(',')
	return db
		.prepare(`SELECT id, corpus_ref AS bookId FROM documents WHERE project_id = ? AND category = 'history' AND corpus_ref IN (${placeholders})`)
		.all(projectId, ...bookIds) as Array<{ id: string; bookId: string }>
}
