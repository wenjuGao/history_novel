import 'server-only'

import { db } from '@/lib/db'
import { corpusDocumentIds } from '@/lib/source-text'
import { yearsIndexReady } from '@/lib/person-years'

// 事件候选：在预处理出的带年纪事（corpus_entry）里，按「时间区间 ∩ 本项目已勾选人物」检索真实记事。
// 只读现成索引，零 Token、不落库；填入表单后仍需人工核对原文并采用。

const VERBS = '擊攻破斬伐討誅圍降奔敗擒獲戰立廢弑篡執虜克陷平救殺'

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
	hasDeath: boolean
	score: number
}

export type CorpusEventResult = { ready: boolean; candidates: CorpusEventCandidate[]; note: string; coverage: { from: number; to: number } | null }

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

export function corpusEventCandidates(
	projectId: string,
	{ startYear, endYear, limit = 40 }: { startYear: number; endYear: number; limit?: number },
): CorpusEventResult {
	const ready = yearsIndexReady()
	const coverage = coverageRange()
	if (!ready) return { ready, candidates: [], note: '带年纪事尚未预处理，请先执行 npm run corpus:years。', coverage }
	if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) return { ready, candidates: [], note: '请填写有效的起止年份。', coverage }
	if (startYear > endYear) return { ready, candidates: [], note: '起始年份不能晚于结束年份。', coverage }

	const people = db.prepare('SELECT id, name FROM characters WHERE project_id = ? AND selected = 1').all(projectId) as Array<{ id: string; name: string }>
	const idsByName = new Map<string, string[]>()
	for (const person of people) idsByName.set(person.name, [...(idsByName.get(person.name) ?? []), person.id])
	// 超出已定年覆盖范围的提示优先于「先勾选人物」：前者决定了这一轮能不能给出候选。
	const outOfRange = coverage !== null && (coverage.to < startYear || coverage.from > endYear)
	const note = outOfRange ? `已定年史料覆盖 ${coverage.from} 至 ${coverage.to} 年，当前区间之外请手工新增。` : ''
	if (!idsByName.size) return { ready, candidates: [], note: note || '事件候选按已勾选的人物检索，请先在第 03 步勾选人物。', coverage }

	const names = [...idsByName.keys()]
	const placeholders = names.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT e.entry_key AS key, e.book_id AS bookId, b.name AS bookName, e.volume_name AS volume,
					e.year_astronomical AS year, e.year_label AS yearLabel, e.period, e.text,
					e.has_death AS hasDeath, e.source_url AS url, p.name AS name
			 FROM corpus_entry e
			 JOIN corpus_entry_person p ON p.entry_key = e.entry_key
			 JOIN corpus_book b ON b.book_id = e.book_id
			 WHERE p.name IN (${placeholders}) AND e.year_astronomical >= ? AND e.year_astronomical <= ?
			 ORDER BY e.year_astronomical, e.sequence LIMIT 4000`,
		)
		.all(...names, startYear, endYear) as Array<{
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
		name: string
	}>

	const documentIds = new Map(corpusDocumentIds(projectId, [...new Set(rows.map((row) => row.bookId))]).map((row) => [row.bookId, row.id]))
	const grouped = new Map<string, { row: (typeof rows)[number]; matched: Set<string> }>()
	for (const row of rows) {
		const entry = grouped.get(row.key) ?? { row, matched: new Set<string>() }
		entry.matched.add(row.name)
		grouped.set(row.key, entry)
	}

	const claimed = new Set(
		(db.prepare('SELECT source_key AS sourceKey FROM plot_events WHERE project_id = ?').all(projectId) as Array<{ sourceKey: string | null }>)
			.map((row) => row.sourceKey)
			.filter((value): value is string => Boolean(value)),
	)

	const candidates: CorpusEventCandidate[] = []
	for (const [key, entry] of grouped) {
		if (claimed.has(`corpus:${key}`)) continue
		const row = entry.row
		const matched = [...entry.matched]
		const participantIds = matched.flatMap((name) => idsByName.get(name) ?? [])
		// 排序分：参与人数最能说明这条记事值得写，其次是死亡记事与动词密度；文本过长的条目不利于人工核对。
		const score =
			participantIds.length * 6 + (row.hasDeath ? 3 : 0) + ([...row.text].some((char) => VERBS.includes(char)) ? 2 : 0) - (row.text.length > 120 ? 1 : 0)
		candidates.push({
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
			names: matched,
			participantIds,
			hasDeath: row.hasDeath === 1,
			score,
		})
	}
	candidates.sort((a, b) => a.year - b.year || b.score - a.score || b.text.length - a.text.length)
	return { ready, candidates: candidates.slice(0, limit), note, coverage }
}
