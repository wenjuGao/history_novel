import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { corpusBooks, astronomicalYear } from './corpus-books.mjs'

export function corpusReportSha256(raw) {
	return createHash('sha256').update(raw, 'utf8').digest('hex')
}

// Streams the local Wikisource snapshots into corpus_book/corpus_volume.
// Rows whose stored text hash already matches are left untouched so citations stay stable across re-runs.
export async function indexCorpus(database, { corpusRoot, onBook } = {}) {
	const reportRaw = await readFile(path.join(corpusRoot, 'report.json'), 'utf8')
	const reportHash = corpusReportSha256(reportRaw)
	const report = JSON.parse(reportRaw)
	const statusById = new Map((report.books ?? []).map((book) => [book.bookId, book]))
	const indexedAt = new Date().toISOString()
	const summary = { reportSha256: reportHash, books: 0, volumes: 0, added: 0, updated: 0, unchanged: 0, characters: 0, missing: [] }

	const insertBook = database.prepare(
		`INSERT INTO corpus_book(book_id, name, title, category, start_year, end_year, coverage_precision, volume_count, page_count, complete, report_sha256, indexed_at)
		 VALUES (@book_id, @name, @title, @category, @start_year, @end_year, 'approx', @volume_count, @page_count, @complete, @report_sha256, @indexed_at)
		 ON CONFLICT(book_id) DO UPDATE SET name = excluded.name, title = excluded.title, category = excluded.category, start_year = excluded.start_year,
			end_year = excluded.end_year, volume_count = excluded.volume_count, page_count = excluded.page_count, complete = excluded.complete,
			report_sha256 = excluded.report_sha256, indexed_at = excluded.indexed_at`,
	)
	const findVolume = database.prepare('SELECT text_sha256 FROM corpus_volume WHERE book_id = ? AND volume_name = ?')
	const insertVolume = database.prepare(
		`INSERT INTO corpus_volume(book_id, volume_name, page_key, source_url, oldid, text, text_length, text_sha256, raw_html_sha256, collected_at, indexed_at)
		 VALUES (@book_id, @volume_name, @page_key, @source_url, @oldid, @text, @text_length, @text_sha256, @raw_html_sha256, @collected_at, @indexed_at)
		 ON CONFLICT(book_id, volume_name) DO UPDATE SET page_key = excluded.page_key, source_url = excluded.source_url, oldid = excluded.oldid, text = excluded.text,
			text_length = excluded.text_length, text_sha256 = excluded.text_sha256, raw_html_sha256 = excluded.raw_html_sha256, collected_at = excluded.collected_at,
			indexed_at = excluded.indexed_at`,
	)

	for (const book of corpusBooks) {
		const directory = path.join(corpusRoot, book.id, 'pages')
		let names
		try {
			names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
		} catch {
			summary.missing.push(`${book.name}：缺少卷页快照目录，请先执行 npm run corpus:fetch`)
			continue
		}

		// better-sqlite3 transactions cannot await, so the page records are loaded first and written in one batch.
		const pages = []
		for (const name of names) {
			const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
			if (typeof record.text !== 'string' || !record.text.trim() || typeof record.volumeName !== 'string') continue
			pages.push({
				book_id: book.id,
				volume_name: record.volumeName,
				page_key: name.replace(/--[^-]*$/, ''),
				source_url: record.sourceUrl ?? '',
				oldid: String(record.oldid ?? ''),
				text: record.text,
				text_length: record.text.length,
				text_sha256: record.textSha256 ?? createHash('sha256').update(record.text, 'utf8').digest('hex'),
				raw_html_sha256: record.rawHtmlSha256 ?? '',
				collected_at: record.fetchedAt ?? '',
				indexed_at: indexedAt,
			})
		}

		let added = 0
		let updated = 0
		let unchanged = 0
		database.transaction(() => {
			// The parent row goes in first: corpus_volume has a foreign key to corpus_book.
			const status = statusById.get(book.id)
			insertBook.run({
				book_id: book.id,
				name: book.name,
				title: book.title,
				category: book.category,
				start_year: astronomicalYear(book.startYear),
				end_year: astronomicalYear(book.endYear),
				volume_count: pages.length,
				page_count: status?.collectedPageCount ?? pages.length,
				complete: status && status.complete ? 1 : 0,
				report_sha256: reportHash,
				indexed_at: indexedAt,
			})
			for (const page of pages) {
				const existing = findVolume.get(page.book_id, page.volume_name)
				if (existing?.text_sha256 === page.text_sha256) {
					unchanged += 1
					continue
				}
				insertVolume.run(page)
				if (existing) updated += 1
				else added += 1
			}
		})()

		summary.books += 1
		summary.volumes += pages.length
		summary.added += added
		summary.updated += updated
		summary.unchanged += unchanged
		summary.characters += pages.reduce((total, page) => total + page.text_length, 0)
		onBook?.(book, pages.length, { added, updated, unchanged })
	}

	database
		.prepare(
			`INSERT INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES ('corpus', ?, ?, ?, ?)
			 ON CONFLICT(kind) DO UPDATE SET sha256 = excluded.sha256, rows = excluded.rows, built_at = excluded.built_at, notes = excluded.notes`,
		)
		.run(reportHash, summary.volumes, indexedAt, JSON.stringify({ books: summary.books, missing: summary.missing }))
	return summary
}

export async function* iterateCorpusVolumes(database) {
	// Paging keeps memory bounded: the full corpus is ~34.5M characters.
	const pageSize = 40
	let offset = 0
	for (;;) {
		const rows = database
			.prepare(
				'SELECT book_id AS bookId, volume_name AS volumeName, text, text_sha256 AS textSha256, source_url AS sourceUrl FROM corpus_volume ORDER BY book_id, volume_name LIMIT ? OFFSET ?',
			)
			.all(pageSize, offset)
		if (!rows.length) return
		for (const row of rows) yield row
		offset += rows.length
	}
}

export function corpusVolumeText(database, bookId, volumeName) {
	const row = database.prepare('SELECT text FROM corpus_volume WHERE book_id = ? AND volume_name = ?').get(bookId, volumeName)
	return row?.text ?? ''
}

export function corpusBooksOverlapping(database, { startYear, endYear }) {
	// 入参与表内一致，均为天文纪年（公元前为负数、无零年），可直接使用 project_scope 的值。
	return database
		.prepare(
			`SELECT book_id AS id, name, title, category, start_year AS startYear, end_year AS endYear, coverage_precision AS precision, volume_count AS volumes, complete
			 FROM corpus_book WHERE start_year <= ? AND end_year >= ? ORDER BY start_year`,
		)
		.all(endYear, startYear)
}
