import 'server-only'

import { db } from '@/lib/db'

// 已确认故事状态（REQ-026、REQ-027、REQ-029）：只有人工接受的章节才固化成状态供后续章节消费；
// 前文一被改写，后续章节与它们的状态就转为待复核/已失效——保留文本，不自动重写，也不进新请求。

export type ChapterStateRow = {
	chapterId: string
	chapterTitle: string
	draftInputHash: string
	specVersion: number | null
	summary: string
	locations: string[]
	relations: string[]
	knowledge: string[]
	threads: string[]
	bodyTail: string
	status: 'confirmed' | 'stale'
	staleReason: string | null
	confirmedAt: string
}

export type ChapterStateInput = {
	chapterTitle: string
	draftInputHash: string
	specVersion: number | null
	summary: string
	locations: string[]
	relations: string[]
	knowledge: string[]
	threads: string[]
	bodyTail: string
}

type StateRow = {
	chapter_id: string
	chapter_title: string
	draft_input_hash: string
	spec_version: number | null
	summary: string
	locations_json: string
	relations_json: string
	knowledge_json: string
	threads_json: string
	body_tail: string
	status: string
	stale_reason: string | null
	confirmed_at: string
}

function toList(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : []
	} catch {
		return []
	}
}

function toRow(row: StateRow): ChapterStateRow {
	return {
		chapterId: row.chapter_id,
		chapterTitle: row.chapter_title,
		draftInputHash: row.draft_input_hash,
		specVersion: row.spec_version,
		summary: row.summary,
		locations: toList(row.locations_json),
		relations: toList(row.relations_json),
		knowledge: toList(row.knowledge_json),
		threads: toList(row.threads_json),
		bodyTail: row.body_tail,
		status: row.status === 'stale' ? 'stale' : 'confirmed',
		staleReason: row.stale_reason,
		confirmedAt: row.confirmed_at,
	}
}

const label = (index: number, title: string) => `第 ${index + 1} 章《${title.slice(0, 40)}》`

// 接受章节时固化状态；同一章重复接受（改完再接受）覆盖为最新内容，本章的待复核标记由接受操作一并清除。
export function confirmChapterState(projectId: string, planVersion: number, chapterId: string, input: ChapterStateInput): void {
	const now = new Date().toISOString()
	db.prepare(
		`INSERT INTO chapter_states(project_id, plan_version, chapter_id, chapter_title, draft_input_hash, spec_version, summary,
			locations_json, relations_json, knowledge_json, threads_json, body_tail, status, stale_reason, confirmed_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?)
		 ON CONFLICT(project_id, plan_version, chapter_id) DO UPDATE SET
			chapter_title = excluded.chapter_title, draft_input_hash = excluded.draft_input_hash, spec_version = excluded.spec_version,
			summary = excluded.summary, locations_json = excluded.locations_json, relations_json = excluded.relations_json,
			knowledge_json = excluded.knowledge_json, threads_json = excluded.threads_json, body_tail = excluded.body_tail,
			status = 'confirmed', stale_reason = NULL, updated_at = excluded.updated_at`,
	).run(
		projectId,
		planVersion,
		chapterId,
		input.chapterTitle.slice(0, 160),
		input.draftInputHash,
		input.specVersion,
		input.summary.slice(0, 4000),
		JSON.stringify(input.locations.slice(0, 40)),
		JSON.stringify(input.relations.slice(0, 40)),
		JSON.stringify(input.knowledge.slice(0, 40)),
		JSON.stringify(input.threads.slice(0, 40)),
		input.bodyTail.slice(-1000),
		now,
		now,
	)
}

// 前文变更（改写、重生成、重新接受）后：后续章节正文保留但标为待复核，其已固化状态转为已失效，不再进入新请求。
export function markFollowingChapters(projectId: string, planVersion: number, laterChapterIds: string[], reason: string): number {
	if (!laterChapterIds.length) return 0
	const now = new Date().toISOString()
	// 生成中的章节同样要标记：它用的是改写前的前文状态，写完即待复核，不能直接接受。
	const draft = db.prepare('UPDATE chapter_drafts SET needs_review = 1, review_reason = ?, updated_at = ? WHERE project_id = ? AND plan_version = ? AND chapter_id = ?')
	const state = db.prepare("UPDATE chapter_states SET status = 'stale', stale_reason = ?, updated_at = ? WHERE project_id = ? AND plan_version = ? AND chapter_id = ?")
	let touched = 0
	db.transaction(() => {
		for (const chapterId of laterChapterIds) {
			touched += draft.run(reason.slice(0, 400), now, projectId, planVersion, chapterId).changes
			state.run(reason.slice(0, 400), now, projectId, planVersion, chapterId)
		}
	})()
	return touched
}

// 本章自身被改写或重新生成：状态作废（不再进入后续请求），但保留旧内容供对照。
export function invalidateChapterState(projectId: string, planVersion: number, chapterId: string, reason: string): void {
	const now = new Date().toISOString()
	db.prepare("UPDATE chapter_states SET status = 'stale', stale_reason = ?, updated_at = ? WHERE project_id = ? AND plan_version = ? AND chapter_id = ?").run(
		reason.slice(0, 400),
		now,
		projectId,
		planVersion,
		chapterId,
	)
}

export function listChapterStates(projectId: string, planVersion: number): ChapterStateRow[] {
	const rows = db
		.prepare('SELECT * FROM chapter_states WHERE project_id = ? AND plan_version = ? ORDER BY rowid')
		.all(projectId, planVersion) as StateRow[]
	return rows.map(toRow)
}

export type StoryStateView = {
	// 送进下一次请求的状态条目（仅已确认、且在目标章之前）。
	states: Array<{ chapterId: string; chapterNumber: number; chapterTitle: string; inputHash: string; specVersion: number | null; confirmedAt: string }>
	// 被排除的条目与原因，界面据此说明「已失效内容」没有静默混入。
	excluded: Array<{ chapterId: string; chapterNumber: number; chapterTitle: string; reason: string }>
	summary: string[]
	locations: string[]
	relations: string[]
	knowledge: string[]
	threads: string[]
}

const maxSummaryChars = 1200
const maxListItems = 40

// 截至目标章之前、按叙述顺序合并的已确认状态。状态表本身按章节存储，这里只做展示与请求拼装用的串联。
export function storyStateBefore(projectId: string, planVersion: number, orderedChapterIds: string[], targetIndex: number, titles: Map<string, string>): StoryStateView {
	const rows = listChapterStates(projectId, planVersion)
	byChapterOrder(rows, orderedChapterIds)
	const view: StoryStateView = { states: [], excluded: [], summary: [], locations: [], relations: [], knowledge: [], threads: [] }
	for (const row of rows) {
		const index = orderedChapterIds.indexOf(row.chapterId)
		if (index < 0 || index >= targetIndex) continue
		const entry = { chapterId: row.chapterId, chapterNumber: index + 1, chapterTitle: row.chapterTitle || titles.get(row.chapterId) || '', inputHash: row.draftInputHash, specVersion: row.specVersion, confirmedAt: row.confirmedAt }
		if (row.status === 'stale') {
			view.excluded.push({ ...entry, reason: row.staleReason ?? '前文已变更，该章状态待复核' })
			continue
		}
		view.states.push(entry)
		const prefix = `${label(index, entry.chapterTitle)}：`
		if (row.summary.trim()) view.summary.push(`${prefix}${row.summary.trim().slice(0, maxSummaryChars)}`)
		for (const item of row.locations) if (view.locations.length < maxListItems) view.locations.push(`${prefix}${item}`)
		for (const item of row.relations) if (view.relations.length < maxListItems) view.relations.push(`${prefix}${item}`)
		for (const item of row.knowledge) if (view.knowledge.length < maxListItems) view.knowledge.push(`${prefix}${item}`)
		for (const item of row.threads) if (view.threads.length < maxListItems) view.threads.push(`${prefix}${item}`)
	}
	return view
}

function byChapterOrder(rows: ChapterStateRow[], orderedChapterIds: string[]) {
	const rank = new Map(orderedChapterIds.map((id, index) => [id, index]))
	rows.sort((a, b) => (rank.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER))
}
