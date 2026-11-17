import 'server-only'

import { db } from '@/lib/db'
import { astronomicalToHistorical } from '@/lib/history-time'
import { activeReferenceSpec } from '@/lib/reference-spec'
import type { GenerationContext } from '@/lib/story-plan'

export type PlotEvent = {
	id: string | null
	sourceKey: string | null
	title: string
	summary: string
	kind: 'historical' | 'fiction'
	status: 'candidate' | 'adopted' | 'rejected'
	origin: 'derived' | 'manual'
	/** 旧派生事件缺少人工确认记录时为 true：未复核前不得用于新章纲与正文。 */
	needsReview: boolean
	documentId: string | null
	documentTitle: string | null
	evidence: string
	region: string
	start: number
	end: number
	participants: Array<{ id: string; name: string; participation: string }>
}

type EventRow = {
	id: string | null
	source_key: string | null
	title: string
	summary: string
	kind: string
	status: string
	origin: string
	needs_review: number
	document_id: string | null
	document_title: string | null
	evidence: string
	region: string
	start_year: number
	end_year: number
}

const maxEvidence = 60

function participantRows(eventIds: string[]) {
	if (!eventIds.length) return new Map<string, Array<{ id: string; name: string; participation: string }>>()
	const placeholders = eventIds.map(() => '?').join(',')
	const rows = db
		.prepare(
			`SELECT p.event_id AS eventId, c.id, c.name, p.participation
			 FROM plot_event_participants p JOIN characters c ON c.id = p.character_id
			 WHERE p.event_id IN (${placeholders}) ORDER BY c.name`,
		)
		.all(...eventIds) as Array<{ eventId: string; id: string; name: string; participation: string }>
	const grouped = new Map<string, Array<{ id: string; name: string; participation: string }>>()
	for (const row of rows) {
		const list = grouped.get(row.eventId) ?? []
		list.push({ id: row.id, name: row.name, participation: row.participation })
		grouped.set(row.eventId, list)
	}
	return grouped
}

function toEvent(row: EventRow, participants: Array<{ id: string; name: string; participation: string }>): PlotEvent {
	return {
		id: row.id,
		sourceKey: row.source_key,
		title: row.title,
		summary: row.summary,
		kind: row.kind === 'fiction' ? 'fiction' : 'historical',
		status: (row.status as PlotEvent['status']) ?? 'candidate',
		origin: (row.origin as PlotEvent['origin']) ?? 'manual',
		needsReview: row.needs_review === 1,
		documentId: row.document_id,
		documentTitle: row.document_title,
		evidence: row.evidence,
		region: row.region,
		start: astronomicalToHistorical(row.start_year),
		end: astronomicalToHistorical(row.end_year),
		participants,
	}
}

export function storedEvents(projectId: string): PlotEvent[] {
	const rows = db
		.prepare(
			`SELECT e.id, e.source_key, e.title, e.summary, e.kind, e.status, e.origin, e.needs_review, e.document_id,
				d.title AS document_title, e.evidence, e.region, e.start_year, e.end_year
			 FROM plot_events e LEFT JOIN documents d ON d.id = e.document_id
			 WHERE e.project_id = ? ORDER BY e.start_year, e.created_at`,
		)
		.all(projectId) as EventRow[]
	const grouped = participantRows(rows.map((row) => row.id!))
	return rows.map((row) => toEvent(row, grouped.get(row.id!) ?? []))
}

// Candidates are computed from the confirmed activity and relation evidence rather than stored,
// so a corrected source record is reflected immediately instead of needing a re-sync.
export function derivedCandidates(projectId: string): PlotEvent[] {
	const activities = db
		.prepare(
			`SELECT c.id AS character_id, c.name, c.evidence, c.document_id, d.title AS document_title,
				a.start_year, a.end_year, a.region
			 FROM characters c
			 JOIN character_activity a ON a.character_id = c.id
			 LEFT JOIN documents d ON d.id = c.document_id
			 WHERE c.project_id = ? ORDER BY a.start_year, c.name`,
		)
		.all(projectId) as Array<{
		character_id: string
		name: string
		evidence: string
		document_id: string
		document_title: string | null
		start_year: number
		end_year: number
		region: string
	}>

	const relations = db
		.prepare(
			`SELECT r.id AS relation_id, r.label, r.evidence, r.document_id, d.title AS document_title,
				r.start_year, r.end_year, f.name AS from_name, t.name AS to_name, f.id AS from_id, t.id AS to_id
			 FROM historical_relations r
			 JOIN characters f ON f.id = r.from_id
			 JOIN characters t ON t.id = r.to_id
			 LEFT JOIN documents d ON d.id = r.document_id
			 WHERE r.project_id = ? AND r.review_status = 'confirmed' AND r.start_year IS NOT NULL
			 ORDER BY r.start_year, r.label`,
		)
		.all(projectId) as Array<{
		relation_id: string
		label: string
		evidence: string
		document_id: string
		document_title: string | null
		start_year: number
		end_year: number
		from_name: string
		to_name: string
		from_id: string
		to_id: string
	}>

	const scopeRegion =
		(db.prepare('SELECT region FROM project_scope WHERE project_id = ?').get(projectId) as { region: string } | undefined)?.region ?? ''

	const candidates: PlotEvent[] = [
		...activities.map((item) =>
			toEvent(
				{
					id: null,
					source_key: `activity:${item.character_id}`,
					title: `${item.name}在${item.region}的活动`,
					summary: item.evidence.slice(0, 200),
					kind: 'historical',
					status: 'candidate',
					origin: 'derived',
					needs_review: 0,
					document_id: item.document_id,
					document_title: item.document_title,
					evidence: item.evidence,
					region: item.region,
					start_year: item.start_year,
					end_year: item.end_year,
				},
				[{ id: item.character_id, name: item.name, participation: '出席' }],
			),
		),
		...relations.map((item) =>
			toEvent(
				{
					id: null,
					source_key: `relation:${item.relation_id}`,
					title: `${item.from_name}与${item.to_name}：${item.label}`,
					summary: item.evidence.slice(0, 200),
					kind: 'historical',
					status: 'candidate',
					origin: 'derived',
					needs_review: 0,
					document_id: item.document_id,
					document_title: item.document_title,
					evidence: item.evidence,
					region: scopeRegion,
					start_year: item.start_year,
					end_year: item.end_year,
				},
				[
					{ id: item.from_id, name: item.from_name, participation: '出席' },
					{ id: item.to_id, name: item.to_name, participation: '出席' },
				],
			),
		),
	]

	const claimed = new Set(storedEvents(projectId).map((event) => event.sourceKey).filter(Boolean))
	return candidates.filter((candidate) => !claimed.has(candidate.sourceKey))
}

export type OutlineEvidence = { id: string; event: PlotEvent }

// Evidence ids are positional over the adopted historical events, so editing the adopted set
// changes the ids; the outline route re-checks every citation against this list.
// 待复核的旧派生事件不算可用依据：作者核对确认后才重新进入。
export function outlineEvidence(projectId: string): OutlineEvidence[] {
	return storedEvents(projectId)
		.filter((event) => event.status === 'adopted' && event.kind === 'historical' && event.evidence.trim() && !event.needsReview)
		.slice(0, maxEvidence)
		.map((event, index) => ({ id: `E${index + 1}`, event }))
}

export function projectScope(projectId: string) {
	const row = db.prepare('SELECT start_year, end_year, region FROM project_scope WHERE project_id = ?').get(projectId) as
		| { start_year: number; end_year: number; region: string }
		| undefined
	if (!row) return null
	return {
		startYear: astronomicalToHistorical(row.start_year),
		endYear: astronomicalToHistorical(row.end_year),
		region: row.region,
		regions: row.region
			.split(/[、,，]/)
			.map((item) => item.trim())
			.filter(Boolean),
	}
}

export function buildGenerationContext(projectId: string): GenerationContext | null {
	const scope = projectScope(projectId)
	if (!scope) return null
	const evidence = outlineEvidence(projectId)
	if (!evidence.length) return null

	const events = storedEvents(projectId)
	const adopted = events.filter((event) => event.status === 'adopted')
	const fictionEvents = adopted.filter((event) => event.kind === 'fiction')
	const people = db
		.prepare('SELECT name FROM characters WHERE project_id = ? AND selected = 1 ORDER BY created_at').all(projectId) as Array<{
		name: string
	}>
	const relations = db
		.prepare(
			`SELECT r.label, r.start_year, r.end_year, f.name AS from_name, t.name AS to_name
			 FROM historical_relations r JOIN characters f ON f.id = r.from_id JOIN characters t ON t.id = r.to_id
			 WHERE r.project_id = ? AND r.review_status = 'confirmed' AND r.start_year IS NOT NULL
			 ORDER BY r.start_year`,
		)
		.all(projectId) as Array<{ label: string; start_year: number; end_year: number; from_name: string; to_name: string }>
	const fictionSettings = db
		.prepare('SELECT kind, title FROM fiction_settings WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<{
		kind: string
		title: string
	}>
	const references = db
		.prepare("SELECT title FROM documents WHERE project_id = ? AND category = 'reference'").all(projectId) as Array<{ title: string }>
	const pinnedReference = activeReferenceSpec(projectId)

	const associationPreview = relations
		.filter((item) => astronomicalToHistorical(item.end_year) >= scope.startYear && astronomicalToHistorical(item.start_year) <= scope.endYear)
		.map((item) => `${astronomicalToHistorical(item.start_year)} 年前后 ${item.from_name}与${item.to_name}：${item.label}`)
		.join('；')

	return {
		scope: { startYear: scope.startYear, endYear: scope.endYear, regions: scope.regions },
		reference: {
			title: pinnedReference?.series ?? references[0]?.title ?? '',
			coverage: pinnedReference
				? `本机已转换 ${pinnedReference.volumes} 卷，只提供抽象写作规格（${pinnedReference.methods.join('、')}），不使用小说原文`
				: `${references.length} 部参考小说`,
			writingSpecification: pinnedReference?.specText ?? '',
			// 送进大纲与正文请求的是作品已确认规格版本里的抽象方法，不是小说原文（REQ-049、REQ-053）。
			originalWritingSpecification: pinnedReference?.methods ?? [],
			specSha256: pinnedReference?.specSha256 || undefined,
			specVersion: pinnedReference?.version ?? undefined,
		},
		historicalCharacters: people.map((person) => person.name),
		associationPreview: associationPreview || '已核定关系均不在当前范围内，只作背景，不据此推断人物当面交往。',
		fiction: [
			...fictionSettings.map((item) => `${item.kind}：${item.title}`),
			...fictionEvents.map((item) => `${item.start}—${item.end} 年 ${item.title}`),
		],
		constraints: [
			`只写 ${scope.startYear} 至 ${scope.endYear} 年、${scope.regions.join('、')}范围内可能发生的事件，不把未来知识赋予人物。`,
			'不改变已核定历史事件的结果与人物结局。',
			'对白、心理、日常场景与史料未载的情节必须标记为虚构。',
			'每处事实断言标注证据编号；编号不足者不作确定断言。',
		],
		evidence: evidence.map(({ id, event }) => ({
			id,
			// 来源事件 ID 让方案确认/生成前的复核门禁按身份精确匹配，不再依赖文本等值。
			sourceEventId: event.id,
			title: event.documentTitle ? `${event.documentTitle}／${event.title}` : event.title,
			revisionUrl: '',
			text: event.evidence,
			status: 'confirmed',
		})),
	}
}
