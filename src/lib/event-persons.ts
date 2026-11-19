import 'server-only'

import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { assertEvidenceInSource } from '@/lib/source-text'
import { personProfiles, profileSpan, type PersonProfile } from '@/lib/person-years'
import { corpusNamesByEntryKeys } from '@/lib/corpus-events'
import type { RevealCue } from '@/lib/plot-events'

// 事件带出的人物：以「已采用的事件」为唯一来源，人名跨事件去重后写入 characters，
// 证据＝该条史料记事原文、出处＝该书已固定资料行；性格与精神风貌在人物步骤由作者或模型补写。
// 自动建立的档案一律 review_status='auto' 且 profile_source=''，界面标「待核」，不宣称史实已审核。

export type PersonSource = { evidence: string; documentId: string | null; region?: string }

/** 线索落底：把事件上已核对的品性线索拼成人物性格/风貌初稿，命中词与出处句一并带上供改写。 */
export function cuesToText(cues: readonly RevealCue[]) {
	return [...new Set(cues.map((cue) => `${cue.kind}「${cue.word}」`))].join('、')
}

export function parseCues(value: string | null | undefined): RevealCue[] {
	try {
		const parsed = JSON.parse(value ?? '[]') as unknown
		if (!Array.isArray(parsed)) return []
		return parsed
			.filter((cue): cue is RevealCue => Boolean(cue) && typeof (cue as RevealCue).word === 'string' && typeof (cue as RevealCue).kind === 'string')
			.slice(0, 8)
			.map((cue) => ({ kind: String(cue.kind).slice(0, 12), word: String(cue.word).slice(0, 40), span: String(cue.span ?? '').slice(0, 160) }))
	} catch {
		return []
	}
}

/** 同名复用（未勾选的置为已勾选），缺失时按这条证据建自动档案。证据定位不了或年份档案明显并代时不建，交人工。 */
export function ensureCharacterByName(
	projectId: string,
	name: string,
	source: PersonSource,
	picked: Set<string>,
	now: string,
	profile?: PersonProfile | null,
): string | null {
	const clean = name.trim()
	// 单字多半是姓氏或官称误抽，不足以成为一位人物。
	if (clean.length < 2) return null
	const existing = db.prepare('SELECT id, selected FROM characters WHERE project_id = ? AND name = ? ORDER BY created_at LIMIT 1').get(projectId, clean) as
		| { id: string; selected: number }
		| undefined
	if (existing) {
		if (!existing.selected) db.prepare('UPDATE characters SET selected = 1 WHERE id = ?').run(existing.id)
		picked.add(clean)
		return existing.id
	}
	if (!source.documentId || !assertEvidenceInSource(projectId, source.documentId, source.evidence).ok) return null
	// 有年份档案但判定不可信的（跨度超常或记事太少），多半把同名的几代人并到了一起，不自动建档案。
	if (profile && !profile.plausible) return null
	const id = randomUUID()
	db.prepare(
		'INSERT INTO characters (id, project_id, name, document_id, evidence, selected, created_at, review_status) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
	).run(id, projectId, clean, source.documentId, source.evidence.slice(0, 4000), now, 'auto')
	const span = profile?.plausible ? profileSpan(profile) : null
	if (span) {
		db.prepare('INSERT OR IGNORE INTO character_activity VALUES (?,?,?,?)').run(id, Math.min(span.start, span.end), Math.max(span.start, span.end), source.region ?? '')
	}
	picked.add(clean)
	return id
}

export type CarryOverResult = { created: string[]; reused: string[]; skipped: Array<{ name: string; reason: string }> }

/**
 * 把已采用的史料事件里的人名去重带成人物：一条事件的证据就是它自己的记事原文，
 * 重复执行只补新增的人名与关联，不会覆盖作者已写好的性格描述。
 */
export function carryOverEventPersons(
	projectId: string,
	/** 只处理这批事件（批量采用后增量带人）；缺省时扫全部已采用事件。 */
	options: { eventIds?: string[] } = {},
): CarryOverResult {
	const eventIds = [...new Set(options.eventIds ?? [])]
	const scope = eventIds.length ? `AND id IN (${eventIds.map(() => '?').join(',')})` : ''
	const events = db
		.prepare(
			`SELECT id, title, summary, evidence, document_id AS documentId, region, source_key AS sourceKey, reveal_cues AS revealCues
			 FROM plot_events WHERE project_id = ? AND status = 'adopted' ${scope} ORDER BY start_year, created_at`,
		)
		.all(projectId, ...eventIds) as Array<{
		id: string
		title: string
		summary: string
		evidence: string
		documentId: string | null
		region: string
		sourceKey: string | null
		revealCues: string | null
	}>
	const result: CarryOverResult = { created: [], reused: [], skipped: [] }
	if (!events.length) return result
	const namesByKey = corpusNamesByEntryKeys(events.map((event) => event.sourceKey ?? '').filter((key) => key.startsWith('corpus:')))
	const known = new Map(
		(db.prepare('SELECT id, name, selected FROM characters WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; selected: number }>).map(
			(row) => [row.name, row],
		),
	)
	const profiles = personProfiles(
		[...new Set(events.flatMap((event) => namesByKey.get(event.sourceKey ?? '') ?? []))],
	)
	const picked = new Set([...known.values()].filter((row) => row.selected === 1).map((row) => row.name))
	const now = new Date().toISOString()
	db.transaction(() => {
		for (const event of events) {
			const cues = parseCues(event.revealCues)
			// 记事里没抽到人名的（如手工事件）沿用已勾选的参与人物，不额外造人；索引键是去掉 corpus: 前缀后的记事键。
			const names = namesByKey.get((event.sourceKey ?? '').replace(/^corpus:/, '')) ?? []
			for (const name of names) {
				const before = known.get(name)
				const personId = ensureCharacterByName(projectId, name, { evidence: event.evidence, documentId: event.documentId, region: event.region }, picked, now, profiles.get(name) ?? null)
				if (!personId) {
					result.skipped.push({ name, reason: before ? '已存在但未通过证据校验' : '证据未命中本机原文、年份档案不可信或人名过短' })
					continue
				}
				if (!before) result.created.push(name)
				else if (!result.reused.includes(name)) result.reused.push(name)
				known.set(name, { id: personId, name, selected: 1 })
				db.prepare('INSERT OR IGNORE INTO plot_event_participants(event_id, character_id) VALUES (?, ?)').run(event.id, personId)
				// 作者还没写过品性时，用这条事件的线索句落一稿待核内容；已有文字一律不覆盖。
				if (cues.length) {
					const current = db.prepare('SELECT personality, temperament FROM characters WHERE id = ?').get(personId) as
						| { personality: string; temperament: string }
						| undefined
					if (current && !current.personality.trim() && !current.temperament.trim()) {
						db.prepare("UPDATE characters SET personality = ?, temperament = '', profile_source = '' WHERE id = ?").run(cuesToText(cues).slice(0, 2000), personId)
					}
				}
			}
		}
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	return result
}

export type EventPersonEvent = {
	id: string
	title: string
	start: number
	end: number
	evidence: string
	reveal: string
	cues: RevealCue[]
}

export type EventPerson = {
	id: string
	name: string
	selected: number
	reviewStatus: string
	personality: string
	temperament: string
	profileSource: string
	evidence: string
	documentTitle: string | null
	/** 该人物在已采用事件里出现的最早/最晚年份（天文纪年）。 */
	firstYear: number | null
	lastYear: number | null
	events: EventPersonEvent[]
}

/** 人物步骤的主列表：由已采用事件带出的人物，含其参与事件与线索，供逐位配置性格与风貌。 */
export function eventBroughtPersons(projectId: string): EventPerson[] {
	const rows = db
		.prepare(
			`SELECT c.id, c.name, c.selected, c.review_status AS reviewStatus, c.personality, c.temperament, c.profile_source AS profileSource,
					c.evidence, d.title AS documentTitle,
					e.id AS eventId, e.title AS eventTitle, e.start_year AS startYear, e.end_year AS endYear, e.evidence AS eventEvidence,
					e.reveal, e.reveal_cues AS revealCues
			 FROM characters c
			 LEFT JOIN documents d ON d.id = c.document_id
			 LEFT JOIN plot_event_participants p ON p.character_id = c.id
			 LEFT JOIN plot_events e ON e.id = p.event_id AND e.status = 'adopted'
			 WHERE c.project_id = ?
			 ORDER BY c.created_at, e.start_year`,
		)
		.all(projectId) as Array<{
		id: string
		name: string
		selected: number
		reviewStatus: string
		personality: string
		temperament: string
		profileSource: string
		evidence: string
		documentTitle: string | null
		eventId: string | null
		eventTitle: string | null
		startYear: number | null
		endYear: number | null
		eventEvidence: string | null
		reveal: string | null
		revealCues: string | null
	}>
	const people = new Map<string, EventPerson>()
	for (const row of rows) {
		const person =
			people.get(row.id) ??
			{
				id: row.id,
				name: row.name,
				selected: row.selected,
				reviewStatus: row.reviewStatus,
				personality: row.personality ?? '',
				temperament: row.temperament ?? '',
				profileSource: row.profileSource ?? '',
				evidence: row.evidence,
				documentTitle: row.documentTitle,
				firstYear: null,
				lastYear: null,
				events: [],
			}
		if (row.eventId && row.eventTitle && row.startYear !== null && row.endYear !== null) {
			if (!person.events.some((event) => event.id === row.eventId)) {
				person.events.push({
					id: row.eventId,
					title: row.eventTitle,
					start: row.startYear,
					end: row.endYear,
					evidence: row.eventEvidence ?? '',
					reveal: row.reveal ?? '',
					cues: parseCues(row.revealCues),
				})
			}
			person.firstYear = person.firstYear === null ? row.startYear : Math.min(person.firstYear, row.startYear)
			person.lastYear = person.lastYear === null ? row.endYear : Math.max(person.lastYear, row.endYear)
		}
		people.set(row.id, person)
	}
	return [...people.values()].sort(
		(a, b) => b.events.length - a.events.length || (a.firstYear ?? 0) - (b.firstYear ?? 0) || a.name.localeCompare(b.name, 'zh'),
	)
}

/** 作者核对模型稿后确认：不改文字，只把待核状态改为已核，来源仍记 model。 */
export function confirmPersonProfile(projectId: string, characterId: string) {
	const changed = db.prepare("UPDATE characters SET review_status = 'confirmed' WHERE id = ? AND project_id = ? AND review_status = 'auto'").run(characterId, projectId)
	if (!changed.changes) throw new Error('该人物不需要确认。')
	db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
}

/** 保存作者手写的性格与风貌：来源转 manual，模型待核稿被人工保存后即视为已核。 */
export function savePersonProfile(projectId: string, characterId: string, personality: string, temperament: string) {
	const changed = db
		.prepare("UPDATE characters SET personality = ?, temperament = ?, profile_source = 'manual' WHERE id = ? AND project_id = ?")
		.run(personality.slice(0, 4000), temperament.slice(0, 4000), characterId, projectId)
	if (!changed.changes) throw new Error('人物不存在。')
	db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
}
