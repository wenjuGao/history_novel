import 'server-only'

import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'

export type EventWriteInput = {
	title: string
	summary: string
	kind: 'historical' | 'fiction'
	region: string
	// 落库存天文纪年（公元前为负、无零年），与展示层的历史纪年互转由调用方负责。
	startYear: number
	endYear: number
	evidence: string
	documentId: string | null
	participantIds: string[]
}

export type EventWriteOptions = {
	status?: 'candidate' | 'adopted' | 'rejected'
	origin?: 'derived' | 'manual'
	sourceKey?: string | null
	eventId?: string
	/** 采用时的人工确认时间：有此记录的事件不再标记待复核。 */
	verifiedAt?: string | null
}

// 单条写入路径：手动新增、候选采用与自动生成共用，避免不同入口写出结构不一致的事件行。
export function writeEvent(projectId: string, input: EventWriteInput, options: EventWriteOptions = {}) {
	const eventId = options.eventId ?? randomUUID()
	const now = new Date().toISOString()
	const status = options.status ?? 'adopted'
	db.prepare(
		`INSERT INTO plot_events(id, project_id, title, summary, kind, status, origin, source_key, document_id, evidence, region, start_year, end_year, created_at, updated_at, needs_review, verified_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		eventId,
		projectId,
		input.title,
		input.summary,
		input.kind,
		status,
		options.origin ?? 'manual',
		options.sourceKey ?? null,
		input.documentId,
		input.evidence,
		input.region,
		input.startYear,
		input.endYear,
		now,
		now,
		status === 'adopted' ? (options.verifiedAt ? 0 : 1) : 0,
		options.verifiedAt ?? null,
	)
	for (const characterId of input.participantIds) {
		db.prepare('INSERT OR IGNORE INTO plot_event_participants(event_id, character_id) VALUES (?, ?)').run(eventId, characterId)
	}
	return eventId
}

export function sourceKeyClaimed(projectId: string, sourceKey: string) {
	return Boolean(db.prepare('SELECT id FROM plot_events WHERE project_id = ? AND source_key = ?').get(projectId, sourceKey))
}
