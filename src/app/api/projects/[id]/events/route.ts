import { NextResponse, type NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { historicalToAstronomical, overlaps } from '@/lib/history-time'
import { derivedCandidates, projectScope, storedEvents, type RevealCue } from '@/lib/plot-events'
import { assertEvidenceInSource, historySources } from '@/lib/source-text'
import { sourceKeyClaimed, writeEvent } from '@/lib/event-writes'
import { corpusEntriesByIds } from '@/lib/corpus-events'
import { carryOverEventPersons } from '@/lib/event-persons'

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

// 品性线索：文本由作者改写，线索（类别／命中词／所在句）只作来源记录，原句一律回读本机史料。
function revealCues(value: unknown, evidence: string): RevealCue[] {
	if (!Array.isArray(value)) return []
	return value
		.map((item) => {
			const cue = (item ?? {}) as Record<string, unknown>
			const span = typeof cue.span === 'string' ? cue.span.trim().slice(0, 160) : ''
			return {
				kind: String(cue.kind ?? '').slice(0, 20),
				word: String(cue.word ?? '').slice(0, 40),
				// 界面改写过的原句不认，只保留仍能在证据原文里定位到的片段。
				span: span && evidence.includes(span) ? span : '',
			}
		})
		.filter((cue) => cue.kind && cue.word)
		.slice(0, 8)
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
			people: db
				.prepare('SELECT id, name, selected, personality, temperament, profile_source, review_status FROM characters WHERE project_id = ? ORDER BY created_at')
				.all(id),
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
		const reveal = typeof body.reveal === 'string' ? body.reveal.trim().slice(0, 4000) : ''
		return { title, summary, kind, region, start, end, evidence, documentId, reveal, cues: revealCues(body.cues, evidence), people: participants(body.participants, id) }
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
				reveal: input.reveal,
				cues: input.cues,
			},
			{ status, origin, sourceKey, verifiedAt },
		)
	}

	try {
		// 批量采用的逐条结果放在这里：事务内只写入，事务外连同最新事件与人物一起回给界面。
		const extra: Record<string, unknown> = {}
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
						reveal: '',
						cues: [],
						people: candidate.participants.map((person) => person.id),
					},
					'adopted',
					'derived',
					sourceKey,
					now,
				)
			} else if (body.action === 'adoptMany') {
				// 多选批量采用：逐条要求「已核对原文」，未勾选原样回传原因；标题、年代、证据一律回读本机史料。
				const items = Array.isArray(body.items) ? body.items : []
				if (!items.length) throw new Error('请先勾选要采用的史料记事。')
				if (items.length > 100) throw new Error('一次最多采用 100 条记事，请分批采用。')
				const wanted = items.map((value) => {
					const item = (value ?? {}) as Record<string, unknown>
					return {
						key: String(item.key ?? '').trim().slice(0, 120),
						confirmed: item.confirmed === true,
						title: typeof item.title === 'string' ? item.title.trim().slice(0, 120) : '',
						summary: typeof item.summary === 'string' ? item.summary.trim().slice(0, 4000) : '',
						reveal: typeof item.reveal === 'string' ? item.reveal.trim().slice(0, 4000) : '',
						cues: Array.isArray(item.cues) ? item.cues : [],
					}
				})
				const entries = new Map(corpusEntriesByIds(id, wanted.map((item) => item.key)).entries.map((entry) => [`corpus:${entry.key}`, entry]))
				const claimed = new Set(
					(db.prepare('SELECT source_key AS sourceKey FROM plot_events WHERE project_id = ?').all(id) as Array<{ sourceKey: string | null }>)
						.map((row) => row.sourceKey)
						.filter((value): value is string => Boolean(value)),
				)
				if (!scope) throw new Error('请先在第 01 步设定历史范围。')
				const scopeFrom = historicalToAstronomical(scope.startYear)
				const scopeTo = historicalToAstronomical(scope.endYear)
				// 参与人物不在这里逐个建：记事里的人名统一交给 carryOverEventPersons 去重带出。
				const region = scope.region.split(/[、,，]/).map((value) => value.trim()).filter(Boolean)[0] ?? ''
				const adopted: Array<{ key: string; eventId: string }> = []
				const skipped: Array<{ key: string; reason: string }> = []
				for (const item of wanted) {
					if (!item.key) continue
					if (!item.confirmed) {
						skipped.push({ key: item.key, reason: '未勾选「已核对原文」' })
						continue
					}
					const entry = entries.get(item.key)
					if (!entry) {
						skipped.push({ key: item.key, reason: '本机史料里找不到这条记事' })
						continue
					}
					if (claimed.has(item.key)) {
						skipped.push({ key: item.key, reason: '该记事已采用过' })
						continue
					}
					if (!overlaps(entry.year, entry.year, scopeFrom, scopeTo)) {
						skipped.push({ key: item.key, reason: `记事不在当前历史范围内（${scope.startYear} 至 ${scope.endYear} 年）` })
						continue
					}
					if (!entry.documentId || !assertEvidenceInSource(id, entry.documentId, entry.text).ok) {
						skipped.push({ key: item.key, reason: '记事原文未能在校验路径上定位' })
						continue
					}
					const eventId = writeEvent(
						id,
						{
							title: item.title || entry.title,
							summary: item.summary || entry.text.slice(0, 4000),
							kind: 'historical',
							region,
							startYear: entry.year,
							endYear: entry.year,
							evidence: entry.text,
							documentId: entry.documentId,
							participantIds: [],
							reveal: item.reveal,
							cues: revealCues(item.cues, entry.text),
						},
						{ status: 'adopted', origin: 'derived', sourceKey: item.key, verifiedAt: now },
					)
					claimed.add(item.key)
					adopted.push({ key: item.key, eventId })
				}
				if (!adopted.length) throw new Error(skipped.length ? `没有记事被采用：${skipped[0].reason}` : '没有可采用的记事。')
				// 事件先落库，再由同一条路径把记事里的人名去重带成人物并挂上参与关系。
				extra.carryOver = carryOverEventPersons(id, { eventIds: adopted.map((item) => item.eventId) })
				extra.adoptedCount = adopted.length
				extra.adoptedKeys = adopted.map((item) => item.key)
				extra.skipped = skipped
			} else if (body.action === 'add') {
				const sourceKey = typeof body.sourceKey === 'string' && body.sourceKey.trim() ? body.sourceKey.trim().slice(0, 120) : null
				if (sourceKey && sourceKeyClaimed(id, sourceKey)) {
					throw new Error('该候选事件已被采用或来源记录已变化，请刷新后重试。')
				}
				// 弹窗里逐条补写：年代、出处与证据仍以本机那条记事为准，作者只改写标题、简介与品性描述。
				const corpusEntry = sourceKey?.startsWith('corpus:') ? corpusEntriesByIds(id, [sourceKey]).entries[0] : undefined
				if (sourceKey?.startsWith('corpus:') && !corpusEntry) throw new Error('本机史料里找不到这条记事，请刷新后重试。')
				const input = corpusEntry ? { ...validate(body), start: corpusEntry.year, end: corpusEntry.year, documentId: corpusEntry.documentId, evidence: corpusEntry.text } : validate(body)
				const status = body.status === 'candidate' ? 'candidate' : 'adopted'
				const eventId = write(input, status, sourceKey ? 'derived' : 'manual', sourceKey, status === 'adopted' ? now : null)
				if (corpusEntry && body.bringPeople === true) extra.carryOver = carryOverEventPersons(id, { eventIds: [eventId] })
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
							document_id = ?, evidence = ?, status = ?, needs_review = ?, verified_at = ?, reveal = ?, reveal_cues = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
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
						input.reveal,
						JSON.stringify(input.cues),
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
		return NextResponse.json({
			ok: true,
			events: storedEvents(id),
			candidates: derivedCandidates(id),
			persons: db
				.prepare('SELECT id, name, selected, personality, temperament, profile_source, review_status FROM characters WHERE project_id = ? AND selected = 1 ORDER BY created_at')
				.all(id),
			...extra,
		})
	} catch (error) {
		const message = error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '保存失败，请检查输入。'
		return NextResponse.json({ error: message }, { status: 400 })
	}
}
