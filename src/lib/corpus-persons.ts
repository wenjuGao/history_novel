import 'server-only'

import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { assertEvidenceInSource, corpusBooksOverlappingScope, corpusDocumentIds, pinCorpus } from '@/lib/source-text'

// 史料人物候选：把启发式索引（corpus_person / corpus_person_edge）按当前时间阶段收敛、打分并标出强关联。
// 这些只是「待确认候选」，写入 characters 时一律 review_status='auto'，不等于已核定的史实。

export type CorpusPersonCandidate = {
	name: string
	mentions: number
	volumeHits: number
	bookCount: number
	books: Array<{ id: string; name: string }>
	strongest: number
	strong: boolean
	score: number
	evidence: string
	evidenceBook: string
	evidenceBookName: string
	evidenceVolume: string
	evidenceUrl: string
}

// 强关联判定阈值：同一条关系在正文中共现次数与跨卷数都要成立，避免单段引文造成的假连接。
const STRONG_CO_MENTIONS = 6
const STRONG_VOLUME_HITS = 2

type PersonRow = {
	name: string
	mentions: number
	volume_hits: number
	volumes: string
	evidence: string
	evidence_volume: string
	evidence_url: string
	book_id: string
	book_name: string
}

// 证据质量：只留人名本身最差，8~84 字之间越长越好（太长不利于人工核对）。
function evidenceQuality(evidence: string, name: string) {
	if (!evidence || evidence === name) return 0
	const length = evidence.length
	if (length < 8) return 1
	if (length > 84) return 2
	return 3 + Math.min(length, 60) / 60
}

function volumeCount(value: string) {
	try {
		const parsed = JSON.parse(value)
		return Array.isArray(parsed) ? parsed.length : 0
	} catch {
		return 0
	}
}

export type CorpusPersonPair = {
	from: string
	to: string
	co: number
	volumes: number
	evidence: string
	bookId: string
	evidenceVolume: string
	evidenceUrl: string
}

// 强关联人物对：与候选打分用同一组阈值，但额外要求证据片段同时出现两个名字，
// 这样自动生成的关系事件引用的原文本身就能支撑这条关系。
export function corpusPersonPairs(projectId: string, names: string[], { limit = 24 }: { limit?: number } = {}): CorpusPersonPair[] {
	const selected = new Set(names)
	if (selected.size < 2) return []
	const bookIds = corpusBooksForScope(projectId).map((book) => book.id)
	if (!bookIds.length) return []
	const placeholders = bookIds.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT book_id, name_a, name_b, co_mentions, volumes, evidence, evidence_volume, evidence_url
			 FROM corpus_person_edge WHERE book_id IN (${placeholders})`,
		)
		.all(...bookIds) as Array<{
		book_id: string
		name_a: string
		name_b: string
		co_mentions: number
		volumes: string
		evidence: string
		evidence_volume: string
		evidence_url: string
	}>

	type Accum = { co: number; volumes: number; best: (typeof rows)[number] | null; bestScore: number }
	const pairs = new Map<string, Accum>()
	for (const row of rows) {
		if (!selected.has(row.name_a) || !selected.has(row.name_b)) continue
		const key = `${row.name_a}\u0001${row.name_b}`
		const entry = pairs.get(key) ?? { co: 0, volumes: 0, best: null, bestScore: -1 }
		entry.co += row.co_mentions
		entry.volumes += volumeCount(row.volumes)
		const bothNamed = row.evidence.includes(row.name_a) && row.evidence.includes(row.name_b)
		const score = (bothNamed ? 100 : 0) + (bothNamed ? Math.min(row.evidence.length, 80) : 0)
		if (score > entry.bestScore) {
			entry.best = row
			entry.bestScore = score
		}
		pairs.set(key, entry)
	}

	const found: CorpusPersonPair[] = []
	for (const [key, entry] of pairs) {
		if (entry.co < STRONG_CO_MENTIONS || entry.volumes < STRONG_VOLUME_HITS) continue
		const best = entry.best
		if (!best || !best.evidence.includes(best.name_a) || !best.evidence.includes(best.name_b)) continue
		const [from, to] = key.split('\u0001')
		found.push({
			from,
			to,
			co: entry.co,
			volumes: entry.volumes,
			evidence: best.evidence,
			bookId: best.book_id,
			evidenceVolume: best.evidence_volume,
			evidenceUrl: best.evidence_url,
		})
	}
	found.sort((a, b) => b.co - a.co || b.volumes - a.volumes || a.from.localeCompare(b.from, 'zh'))
	return found.slice(0, limit)
}

export function corpusBooksForScope(projectId: string) {
	const scope = db.prepare('SELECT start_year AS startYear, end_year AS endYear FROM project_scope WHERE project_id = ?').get(projectId) as
		| { startYear: number; endYear: number }
		| undefined
	return scope ? corpusBooksOverlappingScope(scope.startYear, scope.endYear) : corpusBooksOverlappingScope(-4000, 4000)
}

function aggregate(bookIds: string[], limit: number, blocked: Set<string>) {
	const placeholders = bookIds.map(() => '?').join(',')
	const personRows = db
		.prepare(
			`SELECT p.name, p.mentions, p.volume_hits, p.volumes, p.evidence, p.evidence_volume, p.evidence_url, p.book_id, b.name AS book_name
			 FROM corpus_person p JOIN corpus_book b ON b.book_id = p.book_id
			 WHERE p.book_id IN (${placeholders})`,
		)
		.all(...bookIds) as PersonRow[]
	const edgeRows = db
		.prepare(`SELECT name_a, name_b, co_mentions, volumes FROM corpus_person_edge WHERE book_id IN (${placeholders})`)
		.all(...bookIds) as Array<{ name_a: string; name_b: string; co_mentions: number; volumes: string }>
	const strong = new Map<string, number>()
	const pairs = new Map<string, { co: number; volumes: number }>()
	for (const row of edgeRows) {
		const key = `${row.name_a}\u0001${row.name_b}`
		const entry = pairs.get(key) ?? { co: 0, volumes: 0 }
		entry.co += row.co_mentions
		entry.volumes += volumeCount(row.volumes)
		pairs.set(key, entry)
	}
	for (const [key, entry] of pairs) {
		if (entry.co < STRONG_CO_MENTIONS || entry.volumes < STRONG_VOLUME_HITS) continue
		const [a, b] = key.split('\u0001')
		for (const name of [a, b]) strong.set(name, Math.max(strong.get(name) ?? 0, entry.co))
	}
	const grouped = new Map<string, { mentions: number; volumeHits: number; books: Map<string, string>; best: PersonRow | null; bestQuality: number }>()
	for (const row of personRows) {
		const entry = grouped.get(row.name) ?? { mentions: 0, volumeHits: 0, books: new Map<string, string>(), best: null as PersonRow | null, bestQuality: -1 }
		entry.mentions += row.mentions
		entry.volumeHits += row.volume_hits
		entry.books.set(row.book_id, row.book_name)
		const quality = evidenceQuality(row.evidence, row.name)
		if (quality > entry.bestQuality) {
			entry.best = row
			entry.bestQuality = quality
		}
		grouped.set(row.name, entry)
	}
	const candidates: CorpusPersonCandidate[] = []
	for (const [name, entry] of grouped) {
		if (!entry.best || blocked.has(name)) continue
		const strongest = strong.get(name) ?? 0
		candidates.push({
			name,
			mentions: entry.mentions,
			volumeHits: entry.volumeHits,
			bookCount: entry.books.size,
			books: [...entry.books.entries()].map(([id, bookName]) => ({ id, name: bookName })),
			strongest,
			strong: strongest > 0,
			// 排序权重：跨卷数最能代表「贯穿叙事」，其次是强关联（封顶，避免单书高频对提压过全局主角）、出现次数与跨书数。
			score: entry.volumeHits * 6 + Math.min(strongest, 120) * 3 + Math.min(entry.mentions, 200) + entry.books.size * 10,
			evidence: entry.best.evidence,
			evidenceBook: entry.best.book_id,
			evidenceBookName: entry.best.book_name,
			evidenceVolume: entry.best.evidence_volume,
			evidenceUrl: entry.best.evidence_url,
		})
	}
	candidates.sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name, 'zh'))
	return candidates.slice(0, limit)
}

export function corpusPersonCandidates(projectId: string, { limit = 120 }: { limit?: number } = {}) {
	const books = corpusBooksForScope(projectId)
	const blocked = new Set((db.prepare('SELECT name FROM corpus_person_blocks WHERE project_id = ?').all(projectId) as Array<{ name: string }>).map((row) => row.name))
	const maxCharacters = (db.prepare('SELECT max_characters AS max FROM project_auto_settings WHERE project_id = ?').get(projectId) as { max: number } | undefined)?.max ?? 12
	if (!books.length) return { books, candidates: [] as CorpusPersonCandidate[], defaults: [] as string[], blocked: [...blocked] }
	const candidates = aggregate(books.map((book) => book.id), limit, blocked)
	const defaults = candidates.filter((candidate) => candidate.strong).slice(0, maxCharacters).map((candidate) => candidate.name)
	return { books, candidates, defaults, blocked: [...blocked] }
}

// 把候选写入本项目：证据必须能在校验路径上命中原文，否则整条跳过（不静默放行）。
export function importCorpusPersons(projectId: string, names: string[], { selectedNames = new Set<string>() } = {}) {
	if (!names.length) throw new Error('请先选择至少一位史料人物。')
	if (names.length > 60) throw new Error('单次导入最多 60 位史料人物。')
	const pinning = pinCorpusIfMissing(projectId)
	const documentsByBook = new Map(corpusDocumentIds(projectId, pinning.books.map((book) => book.id)).map((row) => [row.bookId, row.id]))
	const bookYears = new Map(pinning.books.map((book) => [book.id, { startYear: book.startYear, endYear: book.endYear }]))
	const scope = db.prepare('SELECT start_year AS startYear, end_year AS endYear, region FROM project_scope WHERE project_id = ?').get(projectId) as
		| { startYear: number; endYear: number; region: string }
		| undefined
	const existing = new Set((db.prepare('SELECT name FROM characters WHERE project_id = ?').all(projectId) as Array<{ name: string }>).map((row) => row.name))
	const { candidates } = corpusPersonCandidates(projectId, { limit: 600 })
	const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
	const now = new Date().toISOString()
	const inserted: string[] = []
	const skipped: Array<{ name: string; reason: string }> = []
	db.transaction(() => {
		for (const name of names) {
			if (existing.has(name)) {
				skipped.push({ name, reason: '本项目已有同名人物' })
				continue
			}
			const candidate = byName.get(name)
			if (!candidate) {
				skipped.push({ name, reason: '不在当前时间阶段的史料候选中' })
				continue
			}
			const documentId = documentsByBook.get(candidate.evidenceBook)
			if (!documentId || !assertEvidenceInSource(projectId, documentId, candidate.evidence).ok) {
				skipped.push({ name, reason: '证据原文校验未通过' })
				continue
			}
			const characterId = randomUUID()
			db.prepare(
				'INSERT INTO characters (id, project_id, name, document_id, evidence, selected, created_at, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			).run(characterId, projectId, name, documentId, candidate.evidence, selectedNames.has(name) ? 1 : 0, now, 'auto')
			if (scope) {
				const region = scope.region.split(/[、,，]/).map((value) => value.trim()).filter(Boolean)[0] ?? ''
				// 活动时间不再用作品年份代填：先取证据所在书目的年代范围（语料无人物级年份，属近似值，仍待人工核对）。
				const years = bookYears.get(candidate.evidenceBook)
				const startYear = years?.startYear ?? scope.startYear
				const endYear = years?.endYear ?? scope.endYear
				db.prepare('INSERT OR IGNORE INTO character_activity VALUES (?,?,?,?)').run(characterId, Math.min(startYear, endYear), Math.max(startYear, endYear), region)
			}
			inserted.push(name)
		}
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	return { inserted, skipped }
}

function pinCorpusIfMissing(projectId: string) {
	const existing = db.prepare('SELECT books_json FROM project_corpus WHERE project_id = ?').get(projectId) as { books_json: string } | undefined
	if (existing) {
		try {
			const books = JSON.parse(existing.books_json) as Array<{ id: string; name: string; volumes: number; startYear: number; endYear: number }>
			if (books.length) return { books }
		} catch {
			// 落到重新固定，修复损坏的 books_json。
		}
	}
	return pinCorpus(projectId)
}
