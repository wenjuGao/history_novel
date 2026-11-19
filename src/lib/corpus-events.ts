import 'server-only'

import { db } from '@/lib/db'
import { corpusDocumentIds, pinCorpus } from '@/lib/source-text'
import { corpusBooksForScope } from '@/lib/corpus-persons'
import { yearsIndexReady } from '@/lib/person-years'
import { CUE_KINDS, detectCues } from './corpus-character-cues.mjs'
import type { RevealCue } from '@/lib/plot-events'

// 史料事件列表：以事件为主，先按第 01 步的时间阶段取出带年纪事，再标出每条记事体现的人物性格与精神风貌。
// 只读预处理出的现成索引（corpus_entry / corpus_entry_person），零 Token、不落库；勾选核对并采用后才写事件与人物。
// 已勾选人物不再是用前提，只作为排序加权与补写弹窗的检索条件。

const VERBS = '擊攻破斬伐討誅圍降奔敗擒獲戰立廢弑篡執虜克陷平救殺'

/** 区间内一次取全再筛选、分页；超过它说明时间阶段过大，提示收窄而不是静默截断。 */
const scanCeiling = 9000

export type CorpusEventCandidate = {
	key: string
	year: number
	yearLabel: string
	period: string
	text: string
	title: string
	volume: string
	bookId: string
	bookName: string
	documentId: string | null
	url: string
	names: string[]
	participantIds: string[]
	/** 未导入本作品的人名，采用时需一并建成人物。 */
	missingNames: string[]
	cues: RevealCue[]
	/** 1＝有品性线索，2＝行动记事，3＝事务性记事。 */
	tier: number
	hasDeath: boolean
	/** 该项目已采用同一记事生成的事件，列表里标「已采用」并禁止重复写入。 */
	adopted: boolean
	score: number
}

export type CorpusEventResult = {
	ready: boolean
	candidates: CorpusEventCandidate[]
	note: string
	coverage: { from: number; to: number } | null
	/** 过滤后符合该时间阶段的记事总数，用于「加载更多」。 */
	total: number
	kinds: Array<{ kind: string; count: number }>
	people: number
}

export type CorpusEventQuery = {
	startYear: number
	endYear: number
	limit?: number
	offset?: number
	/** 只保留该品性类别命中的记事。 */
	kind?: string | null
	/** 事务性除拜赠谥记事默认折叠，作者可显式要求显示。 */
	includeAdministrative?: boolean
	/** 事件补写弹窗按已勾选人物检索相关记事；主列表不设此条件。 */
	onlySelectedPeople?: boolean
}

/** 记事回读的最小结构：采用时按这个形状取本机史料，不接受界面传来的年代与原文。 */
export type CorpusEntryRow = {
	key: string
	year: number
	yearLabel: string
	period: string
	text: string
	volume: string
	bookId: string
	bookName: string
	url: string
	names: string[]
}

/** 回读结果补上标题与建议标题所需字段，以及该书在 documents 里的固定资料行。 */
export type CorpusEntry = CorpusEntryRow & { title: string; documentId: string | null }

// 标题只是一个可比对的开头：证据文本原样保留，界面里由作者改写。
function suggestTitle(text: string) {
	const cut = text.search(/[，、；。]/)
	return (cut > 0 && cut <= 30 ? text.slice(0, cut) : text.slice(0, 30)).trim()
}

function coverageRange(): { from: number; to: number } | null {
	const row = db.prepare('SELECT MIN(year_astronomical) AS fromYear, MAX(year_astronomical) AS toYear FROM corpus_entry').get() as
		| { fromYear: number | null; toYear: number | null }
		| undefined
	if (!row || row.fromYear === null || row.toYear === null) return null
	return { from: row.fromYear, to: row.toYear }
}

export function corpusEventCandidates(projectId: string, query: CorpusEventQuery): CorpusEventResult {
	const { startYear, endYear, limit = 60, offset = 0, kind = null, includeAdministrative = false, onlySelectedPeople = false } = query
	const ready = yearsIndexReady()
	const coverage = coverageRange()
	const empty: CorpusEventResult = { ready, candidates: [], note: '', coverage, total: 0, kinds: [], people: 0 }
	if (!ready) return { ...empty, note: '带年纪事尚未预处理，请先执行 npm run corpus:years。' }
	if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear > endYear) {
		return { ...empty, note: '请填写有效且不颠倒的起止年份。' }
	}

	const people = db.prepare('SELECT id, name, selected FROM characters WHERE project_id = ?').all(projectId) as Array<{
		id: string
		name: string
		selected: number
	}>
	const idsByName = new Map<string, string[]>()
	for (const person of people) idsByName.set(person.name, [...(idsByName.get(person.name) ?? []), person.id])
	const selectedNames = new Set(people.filter((person) => person.selected === 1).map((person) => person.name))
	const outOfRange = coverage !== null && (coverage.to < startYear || coverage.from > endYear)
	if (outOfRange) {
		return { ...empty, people: selectedNames.size, note: `已定年史料覆盖 ${coverage.from} 至 ${coverage.to} 年，当前区间之外请手工新增。` }
	}

	// 语料范围收敛到与本项目时间阶段有交集的书目，避免把不相干史书的记事混进同一时间轴。
	const books = corpusBooksForScope(projectId)
	const bookIds = books.map((book) => book.id)
	if (!bookIds.length) return { ...empty, note: '本机没有与该时间阶段相交的古籍，请先执行 npm run corpus:index 与 npm run corpus:persons。' }
	const placeholders = bookIds.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT e.entry_key AS key, e.book_id AS bookId, b.name AS bookName, e.volume_name AS volume,
					e.year_astronomical AS year, e.year_label AS yearLabel, e.period, e.text,
					e.has_death AS hasDeath, e.source_url AS url, p.name AS name
			 FROM corpus_entry e
			 LEFT JOIN corpus_entry_person p ON p.entry_key = e.entry_key
			 JOIN corpus_book b ON b.book_id = e.book_id
			 WHERE e.book_id IN (${placeholders}) AND e.year_astronomical >= ? AND e.year_astronomical <= ?
			 ORDER BY e.year_astronomical, e.sequence LIMIT ?`,
		)
		.all(...bookIds, startYear, endYear, scanCeiling * 4) as Array<{
		key: string
		bookId: string
		bookName: string
		volume: string
		year: number
		yearLabel: string
		period: string
		text: string
		hasDeath: number
		url: string
		name: string | null
	}>

	const documentIds = new Map(corpusDocumentIds(projectId, [...new Set(rows.map((row) => row.bookId))]).map((row) => [row.bookId, row.id]))
	const grouped = new Map<string, { row: (typeof rows)[number]; names: Set<string> }>()
	for (const row of rows) {
		const entry = grouped.get(row.key) ?? { row, names: new Set<string>() }
		if (row.name) entry.names.add(row.name)
		grouped.set(row.key, entry)
	}
	if (grouped.size >= scanCeiling) {
		return { ...empty, note: `该时间阶段的记事过多（已超过 ${scanCeiling} 条），请收窄第 01 步的年代区间。` }
	}

	const claimed = new Set(
		(db.prepare('SELECT source_key AS sourceKey FROM plot_events WHERE project_id = ?').all(projectId) as Array<{ sourceKey: string | null }>)
			.map((row) => row.sourceKey)
			.filter((value): value is string => Boolean(value)),
	)

	const all: CorpusEventCandidate[] = []
	for (const [key, entry] of grouped) {
		const row = entry.row
		const names = [...entry.names]
		const found = detectCues(row.text)
		if (found.tier === 0) continue
		const participantIds = names.flatMap((name) => idsByName.get(name) ?? [])
		const missingNames = names.filter((name) => !idsByName.has(name))
		// 排序分：品性线索最能支撑「这个事件值得写成戏」，其次是已勾选人物在场、参与人数与死亡记事。
		let score = found.tier === 1 ? 40 : found.tier === 2 ? 12 : 0
		score += names.length * 4
		if (participantIds.length) score += 10
		if (names.some((name) => selectedNames.has(name))) score += 18
		if (row.hasDeath) score += 6
		if ([...row.text].some((char) => VERBS.includes(char))) score += 4
		if (row.text.length > 160) score -= 2
		all.push({
			key: `corpus:${key}`,
			year: row.year,
			yearLabel: row.yearLabel,
			period: row.period,
			text: row.text,
			title: suggestTitle(row.text),
			volume: row.volume,
			bookId: row.bookId,
			bookName: row.bookName,
			documentId: documentIds.get(row.bookId) ?? null,
			url: row.url,
			names,
			participantIds,
			missingNames,
			cues: found.cues,
			tier: found.tier,
			hasDeath: row.hasDeath === 1,
			adopted: claimed.has(`corpus:${key}`),
			score,
		})
	}

	const kinds = [{ kind: '品性评述', count: 0 }, ...CUE_KINDS.map((group) => ({ kind: group.kind, count: 0 }))]
	const kindIndex = new Map(kinds.map((item) => [item.kind, item]))
	for (const item of all) {
		for (const cue of item.cues) {
			const bucket = kindIndex.get(cue.kind)
			if (bucket) bucket.count += 1
		}
	}

	let pool = all
	if (!includeAdministrative) pool = pool.filter((item) => item.tier !== 3)
	if (kind) pool = pool.filter((item) => item.cues.some((cue) => cue.kind === kind))
	if (onlySelectedPeople) pool = pool.filter((item) => item.names.some((name) => selectedNames.has(name)))

	const filtered = pool.slice().sort((a, b) => a.year - b.year || b.score - a.score || b.text.length - a.text.length)
	return {
		ready,
		candidates: filtered.slice(offset, offset + limit),
		note: '',
		coverage,
		total: filtered.length,
		kinds,
		people: selectedNames.size,
	}
}

/** 采用时按记事键回读：标题、年代、原文与出处一律取本机史料，界面传来的同名文本不作依据。 */
export function corpusEntriesByIds(projectId: string, keys: string[]): { entries: CorpusEntry[]; missing: string[] } {
	const stripped = [...new Set(keys.map((key) => key.replace(/^corpus:/, '')).filter(Boolean))]
	if (!stripped.length) return { entries: [], missing: [] }
	const placeholders = stripped.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT e.entry_key AS key, e.book_id AS bookId, b.name AS bookName, e.volume_name AS volume,
					e.year_astronomical AS year, e.year_label AS yearLabel, e.period, e.text, e.source_url AS url, p.name AS name
			 FROM corpus_entry e
			 LEFT JOIN corpus_entry_person p ON p.entry_key = e.entry_key
			 JOIN corpus_book b ON b.book_id = e.book_id
			 WHERE e.entry_key IN (${placeholders})
			 ORDER BY e.year_astronomical, e.sequence`,
		)
		.all(...stripped) as Array<Omit<CorpusEntryRow, 'names'> & { name: string | null }>
	const grouped = new Map<string, CorpusEntryRow>()
	for (const row of rows) {
		const entry = grouped.get(row.key) ?? { ...row, names: [] as string[] }
		if (row.name && !entry.names.includes(row.name)) entry.names.push(row.name)
		grouped.set(row.key, entry)
	}
	const found = [...grouped.values()]
	// 出处行缺失时先补齐固定资料（幂等），否则证据无法定位到本机古籍原文。
	const documentIds = new Map(corpusDocumentIds(projectId, [...new Set(found.map((row) => row.bookId))]).map((row) => [row.bookId, row.id]))
	if (found.length && found.some((row) => !documentIds.has(row.bookId))) {
		pinCorpus(projectId)
		for (const row of corpusDocumentIds(projectId, [...new Set(found.map((entry) => entry.bookId))])) documentIds.set(row.bookId, row.id)
	}
	const withDocuments = found.map((row) => ({ ...row, title: suggestTitle(row.text), documentId: documentIds.get(row.bookId) ?? null }))
	const missing = stripped.filter((key) => !grouped.has(key))
	return { entries: withDocuments, missing }
}

export type BroughtPerson = {
	name: string
	/** 本项目已有的同名人物；为空表示采用时需要新建。 */
	characterId: string | null
	/** 命中该人物的记事条数（本次勾选范围内）。 */
	eventCount: number
	firstYear: number | null
	lastYear: number | null
}

/** 勾选记事带出的人物预览：按人名去重，并标出哪些还需要建立人物档案。 */
export function charactersForEventKeys(projectId: string, keys: string[]): BroughtPerson[] {
	const { entries } = corpusEntriesByIds(projectId, keys)
	const existing = new Map(
		(db.prepare('SELECT id, name FROM characters WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string }>).map((row) => [row.name, row.id]),
	)
	const grouped = new Map<string, BroughtPerson>()
	for (const entry of entries) {
		for (const name of entry.names) {
			const person = grouped.get(name) ?? { name, characterId: existing.get(name) ?? null, eventCount: 0, firstYear: null, lastYear: null }
			person.eventCount += 1
			person.firstYear = person.firstYear === null ? entry.year : Math.min(person.firstYear, entry.year)
			person.lastYear = person.lastYear === null ? entry.year : Math.max(person.lastYear, entry.year)
			grouped.set(name, person)
		}
	}
	return [...grouped.values()].sort((a, b) => b.eventCount - a.eventCount || (a.firstYear ?? 0) - (b.firstYear ?? 0) || a.name.localeCompare(b.name, 'zh'))
}

/** 已采用事件回读史料人名：键为 source_key（corpus:…），值为该条记事抽出的人名，用于把人名带成人物。 */
export function corpusNamesByEntryKeys(keys: string[]): Map<string, string[]> {
	const stripped = [...new Set(keys.map((key) => key.replace(/^corpus:/, '')).filter(Boolean))]
	const names = new Map<string, string[]>()
	if (!stripped.length) return names
	const placeholders = stripped.map(() => '?').join(',')
	const rows = db
		.prepare(`SELECT entry_key AS key, name FROM corpus_entry_person WHERE entry_key IN (${placeholders}) ORDER BY entry_key, name`)
		.all(...stripped) as Array<{ key: string; name: string }>
	for (const row of rows) {
		const list = names.get(row.key) ?? []
		if (!list.includes(row.name)) list.push(row.name)
		names.set(row.key, list)
	}
	return names
}
