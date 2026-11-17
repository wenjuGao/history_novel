import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { historicalToAstronomical, overlaps } from '@/lib/history-time'
import { derivedCandidates, projectScope, storedEvents } from '@/lib/plot-events'
import { assertEvidenceInSource, historySources } from '@/lib/source-text'
import { sourceKeyClaimed, writeEvent } from '@/lib/event-writes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

function text(value: unknown, field: string, max: number) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${field}。`)
	const trimmed = value.trim()
	if (trimmed.length > max) throw new Error(`${field}过长（最多 ${max} 个字符）。`)
	return trimmed
}

function years(value: unknown, field: string) {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed === 0 || Math.abs(parsed) > 10000) throw new Error(`${field}必须是非零整数年份。`)
	return historicalToAstronomical(parsed)
}

function participants(value: unknown, projectId: string) {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value) || value.length > 12) throw new Error('参与人物最多选择 12 位。')
	const known = new Set(
		(db.prepare('SELECT id FROM characters WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((person) => person.id),
	)
	const ids = [...new Set(value.map((item) => String(item)))]
	if (ids.some((id) => !known.has(id))) throw new Error('参与人物必须来自本作品已核定的人物。')
	return ids
}

function evidenceCheck(documentId: string | null, evidence: string, projectId: string, confirmed: unknown) {
	if (!documentId) throw new Error('历史事件需要选择出处资料并摘录原文证据。')
	if (!evidence) throw new Error('历史事件需要摘录原文证据。')
	const located = assertEvidenceInSource(projectId, documentId, evidence)
	if (!located.ok) throw new Error('证据必须来自当前作品的历史资料原文。')
	if (confirmed !== true) throw new Error('请核对原文确实支持该事件后再确认。')
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })

	return NextResponse.json(
		{
			scope: projectScope(id),
			events: storedEvents(id),
			candidates: derivedCandidates(id),
			people: db.prepare('SELECT id, name, selected FROM characters WHERE project_id = ? ORDER BY created_at').all(id),
			sources: historySources(id),
		},
		{ headers: { 'cache-control': 'no-store' } },
	)
}

export async function POST(request: NextRequest, context: Context) {
	if (!isSameOriginLoopback(request)) return NextResponse.json({ error: '请求来源无效。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })

	let body: Record<string, unknown>
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: '请求内容无效。' }, { status: 400 })
	}

	const scope = projectScope(id)

	function requireScopeRange(start: number, end: number) {
		if (!scope) return
		if (!overlaps(start, end, historicalToAstronomical(scope.startYear), historicalToAstronomical(scope.endYear))) {
			throw new Error(`事件时间需与当前历史范围（${scope.startYear} 至 ${scope.endYear} 年）重叠。`)
		}
	}

	function validate(body: Record<string, unknown>) {
		const title = text(body.title, '事件名称', 120)
		const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 4000) : ''
		const kind: 'historical' | 'fiction' | null = body.kind === 'fiction' ? 'fiction' : body.kind === 'historical' ? 'historical' : null
		if (!kind) throw new Error('事件类型需为历史事件或虚构事件。')
		const region = typeof body.region === 'string' ? body.region.trim().slice(0, 200) : (scope?.region ?? '')
		const start = years(body.start, '起始年份')
		const end = years(body.end, '结束年份')
		if (start > end) throw new Error('起始年份不能晚于结束年份。')
		requireScopeRange(start, end)
		const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : ''
		const documentId = typeof body.documentId === 'string' && body.documentId.trim() ? body.documentId.trim() : null
		if (kind === 'historical') evidenceCheck(documentId, evidence, id, body.confirmed)
		return { title, summary, kind, region, start, end, evidence, documentId, people: participants(body.participants, id) }
	}

	const now = new Date().toISOString()

	function write(input: ReturnType<typeof validate>, status: 'candidate' | 'adopted' | 'rejected', origin: 'derived' | 'manual', sourceKey: string | null, verifiedAt: string | null = null) {
		return writeEvent(
			id,
			{
				title: input.title,
				summary: input.summary,
				kind: input.kind,
				region: input.region,
				startYear: input.start,
				endYear: input.end,
				evidence: input.evidence,
				documentId: input.documentId,
				participantIds: input.people,
			},
			{ status, origin, sourceKey, verifiedAt },
		)
	}

	try {
		db.transaction(() => {
			if (body.action === 'adopt') {
				const sourceKey = text(body.sourceKey, '事件来源标记', 120)
				// 采用即人工核对：须确认已核对原文，且证据须命中当前作品的历史资料。
				if (body.confirmed !== true) throw new Error('请核对原文确实支持该候选事件后再采用。')
				const candidate = derivedCandidates(id).find((item) => item.sourceKey === sourceKey)
				if (!candidate) throw new Error('该候选事件已被采用或来源记录已变化，请刷新后重试。')
				if (!candidate.documentId || !assertEvidenceInSource(id, candidate.documentId, candidate.evidence).ok) {
					throw new Error('候选事件证据未命中当前作品的历史资料原文，请先修正来源记录。')
				}
				requireScopeRange(historicalToAstronomical(candidate.start), historicalToAstronomical(candidate.end))
				write(
					{
						title: candidate.title,
						summary: candidate.summary,
						kind: 'historical',
						region: candidate.region,
						start: historicalToAstronomical(candidate.start),
						end: historicalToAstronomical(candidate.end),
						evidence: candidate.evidence,
						documentId: candidate.documentId,
						people: candidate.participants.map((person) => person.id),
					},
					'adopted',
					'derived',
					sourceKey,
					now,
				)
			} else if (body.action === 'add') {
				const sourceKey = typeof body.sourceKey === 'string' && body.sourceKey.trim() ? body.sourceKey.trim().slice(0, 120) : null
				if (sourceKey && sourceKeyClaimed(id, sourceKey)) {
					throw new Error('该候选事件已被采用或来源记录已变化，请刷新后重试。')
				}
				const status = body.status === 'candidate' ? 'candidate' : 'adopted'
				write(validate(body), status, sourceKey ? 'derived' : 'manual', sourceKey, status === 'adopted' ? now : null)
			} else if (body.action === 'verify') {
				// 旧派生事件的复核确认：核对原文后记录确认时间，事件重新可用作大纲与正文依据。
				const eventId = text(body.id, '事件编号', 100)
				const existing = db
					.prepare('SELECT id, status, kind, document_id, evidence, start_year, end_year, needs_review FROM plot_events WHERE id = ? AND project_id = ?')
					.get(eventId, id) as { id: string; status: string; kind: string; document_id: string | null; evidence: string; start_year: number; end_year: number; needs_review: number } | undefined
				if (!existing) throw new Error('事件不存在。')
				if (existing.needs_review !== 1) throw new Error('该事件无需复核。')
				if (existing.status !== 'adopted') throw new Error('只有已采用事件需要复核。')
				if (body.confirmed !== true) throw new Error('请核对原文确实支持该事件的内容、年代与参与人物后再确认。')
				if (existing.kind === 'historical') {
					if (!existing.document_id || !assertEvidenceInSource(id, existing.document_id, existing.evidence).ok) {
						throw new Error('证据未命中当前作品的历史资料原文，请先编辑修正该事件。')
					}
					requireScopeRange(existing.start_year, existing.end_year)
				}
				db.prepare('UPDATE plot_events SET needs_review = 0, verified_at = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(now, now, eventId, id)
			} else if (body.action === 'update') {
				const eventId = text(body.id, '事件编号', 100)
				const existing = db.prepare('SELECT id, status, kind, document_id, evidence, start_year, end_year FROM plot_events WHERE id = ? AND project_id = ?').get(eventId, id) as
					| { id: string; status: string; kind: string; document_id: string | null; evidence: string; start_year: number; end_year: number }
					| undefined
				if (!existing) throw new Error('事件不存在。')
				if (body.status === 'restore' || body.status === 'reject' || body.status === 'adopt') {
					const status = body.status === 'restore' ? 'candidate' : body.status === 'reject' ? 'rejected' : 'adopted'
					if (status === 'adopted') {
						requireScopeRange(existing.start_year, existing.end_year)
						// 采纳即人工核对：须确认已核对原文，历史事件还须复核证据仍命中资料原文。
						if (body.confirmed !== true) throw new Error('请核对原文确实支持该事件后再采用。')
						if (existing.kind === 'historical' && (!existing.document_id || !assertEvidenceInSource(id, existing.document_id, existing.evidence).ok)) {
							throw new Error('证据未命中当前作品的历史资料原文，请先编辑修正该事件。')
						}
					}
					if (status === 'adopted') {
						db.prepare('UPDATE plot_events SET status = ?, needs_review = 0, verified_at = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(status, now, now, eventId, id)
					} else {
						db.prepare('UPDATE plot_events SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(status, now, eventId, id)
					}
				} else {
					const input = validate(body)
					const nextStatus = body.status === 'candidate' || body.status === 'adopted' || body.status === 'rejected' ? body.status : existing.status
					if (nextStatus === 'adopted' && body.confirmed !== true) throw new Error('请核对原文确实支持该事件后再采用。')
					db.prepare(
						`UPDATE plot_events SET title = ?, summary = ?, kind = ?, region = ?, start_year = ?, end_year = ?,
							document_id = ?, evidence = ?, status = ?, needs_review = ?, verified_at = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
					).run(
						input.title,
						input.summary,
						input.kind,
						input.region,
						input.start,
						input.end,
						input.documentId,
						input.evidence,
						nextStatus,
						0,
						nextStatus === 'adopted' ? now : null,
						now,
						eventId,
						id,
					)
					db.prepare('DELETE FROM plot_event_participants WHERE event_id = ?').run(eventId)
					for (const characterId of input.people) {
						db.prepare('INSERT OR IGNORE INTO plot_event_participants(event_id, character_id) VALUES (?, ?)').run(eventId, characterId)
					}
				}
			} else if (body.action === 'remove') {
				const eventId = text(body.id, '事件编号', 100)
				if (!db.prepare('DELETE FROM plot_events WHERE id = ? AND project_id = ?').run(eventId, id).changes) throw new Error('事件不存在。')
			} else throw new Error('操作无效。')
			db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
		})()
		return NextResponse.json({ ok: true, events: storedEvents(id), candidates: derivedCandidates(id) })
	} catch (error) {
		const message = error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '保存失败，请检查输入。'
		return NextResponse.json({ error: message }, { status: 400 })
	}
}
