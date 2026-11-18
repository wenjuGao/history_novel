import 'server-only'

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { MAX_PLAN_CHAPTERS } from '@/lib/plan-limits'

export type Chapter = {
	id: string
	title: string
	pov: string
	// 本章故事时间设定（如「904 年秋，汴州」）；旧规划没有该字段，故为可选。
	time?: string
	synopsis: string
	plot: string[]
	historyEvidence: string[]
	fiction: string[]
	endingHook: string
}

export type GenerationContext = {
	scope: unknown
	reference: { title?: string; coverage?: string; writingSpecification?: string; originalWritingSpecification?: string[]; specSha256?: string; specVersion?: number }
	historicalCharacters: string[]
	associationPreview: string
	fiction: unknown[]
	constraints: string[]
	evidence: Array<{ id: string; title: string; revisionUrl: string; text: string; status: string; sourceEventId?: string | null }>
}

export type PlanOrigin = 'local' | 'model' | 'manual'

/** 章纲保存时记录当时选定的剧情提案（槽位、修订号与输入版本哈希），见 src/lib/proposal-binding.ts。 */
export type ProposalBinding = {
	slot: number
	revision: number
	inputHash: string
	title: string
}

export type StoryPlan = {
	schemaVersion: number
	// 大纲来源：本地骨架／模型扩写／人工编辑，仅用于界面标注，不参与结构校验。
	origin?: PlanOrigin
	// 章纲绑定的选定提案；改版前保存的规划没有该字段，确认方案时会被要求重新保存。
	proposal?: ProposalBinding | null
	title: string
	scope: { period: string; regions: string[]; plannedChapters: number }
	synopsis: string
	centralQuestion: string
	historicalAnchors: Array<{ evidenceId: string; fact: string }>
	fictionBoundary: string[]
	chapters: Chapter[]
	humanReviewQuestions: string[]
	generationContext?: GenerationContext
}

export type PlanRow = { version: number; plan_json: string; plan_hash: string }

export class PlanVersionError extends Error {
	constructor(message = '规划版本已变化，请重新载入后再保存。') {
		super(message)
		this.name = 'PlanVersionError'
	}
}

export function sha256(value: string) {
	return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function readPlan(projectId: string): PlanRow | undefined {
	return db.prepare('SELECT version, plan_json, plan_hash FROM story_plans WHERE project_id = ?').get(projectId) as PlanRow | undefined
}

export function parsePlan(row: PlanRow): StoryPlan {
	return JSON.parse(row.plan_json) as StoryPlan
}

export function validPlan(value: unknown): value is StoryPlan {
	if (!value || typeof value !== 'object') return false
	const plan = value as Partial<StoryPlan>
	if (
		typeof plan.title !== 'string' || plan.title.trim().length < 1 || plan.title.length > 120 ||
		typeof plan.synopsis !== 'string' || plan.synopsis.length > 10000 ||
		typeof plan.centralQuestion !== 'string' || plan.centralQuestion.length > 2000 ||
		!Array.isArray(plan.chapters) || plan.chapters.length < 1 || plan.chapters.length > MAX_PLAN_CHAPTERS ||
		!Array.isArray(plan.scope?.regions) || !Array.isArray(plan.historicalAnchors) ||
		!Array.isArray(plan.fictionBoundary) || !Array.isArray(plan.humanReviewQuestions)
	) return false

	const ids = new Set<string>()
	return plan.chapters.every((chapter) => {
		if (
			!chapter || !/^chapter-[a-z0-9-]+$/.test(chapter.id) || ids.has(chapter.id) ||
			typeof chapter.title !== 'string' || chapter.title.length > 160 ||
			typeof chapter.pov !== 'string' || chapter.pov.length > 80 ||
			(chapter.time !== undefined && (typeof chapter.time !== 'string' || chapter.time.length > 160)) ||
			typeof chapter.synopsis !== 'string' || chapter.synopsis.length > 4000 ||
			!Array.isArray(chapter.plot) || chapter.plot.length < 1 || chapter.plot.length > 20 ||
			chapter.plot.some((item) => typeof item !== 'string' || item.length > 2000) ||
			!Array.isArray(chapter.historyEvidence) || !Array.isArray(chapter.fiction) ||
			typeof chapter.endingHook !== 'string' || chapter.endingHook.length > 2000
		) return false
		ids.add(chapter.id)
		return true
	})
}

/** 参与本章正文请求的章纲字段；任一变化都让已接受正文失去原来的输入版本。 */
function chapterSignature(chapter: Chapter | undefined) {
	if (!chapter) return ''
	return JSON.stringify([chapter.title, chapter.pov, chapter.time ?? '', chapter.synopsis, chapter.plot, chapter.historyEvidence, chapter.fiction, chapter.endingHook])
}

type CarriedDraft = {
	chapterId: string
	content: string
	status: 'draft' | 'accepted'
	inputHash: string
	createdAt: string
	needsReview: number
	reviewReason: string | null
	metaJson: string | null
	rawOutput: string | null
	estimatedCostCny: number
	actualCostCny: number | null
	promptTokens: number | null
	completionTokens: number | null
	requestId: string | null
	errorMessage: string | null
}

type CarriedState = {
	chapterId: string
	draftInputHash: string
	specVersion: number | null
	summary: string
	locationsJson: string
	relationsJson: string
	knowledgeJson: string
	threadsJson: string
	bodyTail: string
	status: 'confirmed' | 'stale'
	staleReason: string | null
	confirmedAt: string
}

// 章纲改版（包括「AI 续设下一章」后保存目录）不得把已确认的章节退回未生成：草稿与故事状态按章节 ID
// 继承到新版本。章纲设定未变且其前序章节同样完整继承时，已接受状态与既定事实原样沿用；否则保留正文、
// 标为待复核并把状态转为已失效，交由作者复核后重新接受，不重写也不删除任何文本。
function carryForwardChapters(
	projectId: string,
	oldVersion: number,
	newVersion: number,
	newPlanHash: string,
	oldChapters: Chapter[],
	newChapters: Chapter[],
	now: string,
) {
	const drafts = db
		.prepare(
			`SELECT chapter_id AS chapterId, content, status, request_id AS requestId, input_hash AS inputHash,
				estimated_cost_cny AS estimatedCostCny, actual_cost_cny AS actualCostCny,
				prompt_tokens AS promptTokens, completion_tokens AS completionTokens, error_message AS errorMessage,
				created_at AS createdAt, meta_json AS metaJson, raw_output AS rawOutput,
				needs_review AS needsReview, review_reason AS reviewReason
			 FROM chapter_drafts WHERE project_id = ? AND plan_version = ? AND status IN ('draft', 'accepted')`,
		)
		.all(projectId, oldVersion) as CarriedDraft[]
	const draftsById = new Map(drafts.map((item) => [item.chapterId, item]))
	const states = db
		.prepare(
			`SELECT chapter_id AS chapterId, draft_input_hash AS draftInputHash, spec_version AS specVersion, summary,
				locations_json AS locationsJson, relations_json AS relationsJson, knowledge_json AS knowledgeJson,
				threads_json AS threadsJson, body_tail AS bodyTail, status, stale_reason AS staleReason, confirmed_at AS confirmedAt
			 FROM chapter_states WHERE project_id = ? AND plan_version = ?`,
		)
		.all(projectId, oldVersion) as CarriedState[]
	const statesById = new Map(states.map((item) => [item.chapterId, item]))
	const oldSignatures = new Map(oldChapters.map((chapter) => [chapter.id, chapterSignature(chapter)]))

	const insertDraft = db.prepare(
		`INSERT INTO chapter_drafts(project_id, plan_version, plan_hash, chapter_id, chapter_title, content, status,
			request_id, input_hash, estimated_cost_cny, actual_cost_cny, prompt_tokens, completion_tokens, error_message,
			created_at, updated_at, active_attempt_id, meta_json, raw_output, needs_review, review_reason, auto_continuations)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)`,
	)
	const insertState = db.prepare(
		`INSERT INTO chapter_states(project_id, plan_version, chapter_id, chapter_title, draft_input_hash, spec_version, summary,
			locations_json, relations_json, knowledge_json, threads_json, body_tail, status, stale_reason, confirmed_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id, plan_version, chapter_id) DO UPDATE SET
			draft_input_hash = excluded.draft_input_hash, spec_version = excluded.spec_version, summary = excluded.summary,
			locations_json = excluded.locations_json, relations_json = excluded.relations_json,
			knowledge_json = excluded.knowledge_json, threads_json = excluded.threads_json, body_tail = excluded.body_tail,
			status = excluded.status, stale_reason = excluded.stale_reason, updated_at = excluded.updated_at`,
	)

	let prefixIntact = true
	let preserved = 0
	let needsReview = 0
	let carried = 0
	for (const chapter of newChapters) {
		const draft = draftsById.get(chapter.id)
		if (!draft) continue
		const settingChanged = oldSignatures.get(chapter.id) !== chapterSignature(chapter)
		const intact = draft.status === 'accepted' && draft.needsReview !== 1 && !settingChanged && prefixIntact
		const state = statesById.get(chapter.id) ?? null
		if (intact) {
			preserved += 1
			insertDraft.run(
				projectId, newVersion, newPlanHash, chapter.id, chapter.title, draft.content, draft.status,
				draft.requestId, draft.inputHash, draft.estimatedCostCny, draft.actualCostCny, draft.promptTokens,
				draft.completionTokens, draft.errorMessage, draft.createdAt, now, draft.metaJson, draft.rawOutput,
				0, null,
			)
			if (state) insertState.run(projectId, newVersion, chapter.id, chapter.title, state.draftInputHash, state.specVersion, state.summary, state.locationsJson, state.relationsJson, state.knowledgeJson, state.threadsJson, state.bodyTail, state.status, state.staleReason, state.confirmedAt, now)
		} else {
			const reason = draft.needsReview === 1
				? draft.reviewReason ?? '前文变更导致的待复核状态随章纲改版保留。'
				: settingChanged
					? '本章章纲设定已改写，已接受正文保留，需复核后重新接受。'
					: draft.status === 'accepted'
						? '本章之前的章节在改版后已变化或尚未接受，已接受正文保留，需复核后重新接受。'
						: null
			if (draft.status === 'accepted') needsReview += 1
			insertDraft.run(
				projectId, newVersion, newPlanHash, chapter.id, chapter.title, draft.content, draft.status,
				draft.requestId, draft.inputHash, draft.estimatedCostCny, draft.actualCostCny, draft.promptTokens,
				draft.completionTokens, draft.errorMessage, draft.createdAt, now, draft.metaJson, draft.rawOutput,
				draft.status === 'accepted' ? 1 : draft.needsReview, reason,
			)
			if (state) insertState.run(projectId, newVersion, chapter.id, chapter.title, state.draftInputHash, state.specVersion, state.summary, state.locationsJson, state.relationsJson, state.knowledgeJson, state.threadsJson, state.bodyTail, 'stale', reason ?? '章纲改版后本章尚未重新接受，其故事状态不进入新请求。', state.confirmedAt, now)
		}
		carried += 1
		if (!intact) prefixIntact = false
	}
	return { carried, preserved, needsReview }
}

// 人工确认按 (project_id, plan_version) 保存，因此新版本仍会撤销上一次方案级确认；
// 章节正文与已固化故事状态由 carryForwardChapters 继承到新版本，不会退回未生成。
export function commitPlan(projectId: string, plan: StoryPlan, expectedVersion: number | null) {
	const planJson = JSON.stringify(plan)
	if (Buffer.byteLength(planJson, 'utf8') > 250_000) throw new Error('规划内容过大。')
	const planHash = sha256(planJson)
	const now = new Date().toISOString()

	return db.transaction(() => {
		const current = readPlan(projectId)
		if (!current) {
			if (expectedVersion !== null && expectedVersion !== 0) throw new PlanVersionError()
			db.prepare('INSERT INTO story_plans(project_id, version, plan_json, plan_hash, updated_at) VALUES (?, 1, ?, ?, ?)').run(projectId, planJson, planHash, now)
			db.prepare('INSERT INTO story_plan_revisions(project_id, version, plan_json, plan_hash, created_at) VALUES (?, 1, ?, ?, ?)').run(projectId, planJson, planHash, now)
			db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
			return { version: 1, planHash, planJson, carried: 0, preserved: 0, needsReview: 0 }
		}
		if (expectedVersion !== null && expectedVersion !== current.version) throw new PlanVersionError()
		if (db.prepare("SELECT chapter_id FROM chapter_drafts WHERE project_id = ? AND status = 'generating'").get(projectId)) {
			throw new Error('章节正在生成，请等待本次任务结束后再修改规划。')
		}
		const version = current.version + 1
		db.prepare('INSERT INTO story_plan_revisions(project_id, version, plan_json, plan_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, version, planJson, planHash, now)
		db.prepare('UPDATE story_plans SET version = ?, plan_json = ?, plan_hash = ?, updated_at = ? WHERE project_id = ?').run(version, planJson, planHash, now, projectId)
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
		const carried = carryForwardChapters(projectId, current.version, version, planHash, parsePlan(current).chapters, plan.chapters, now)
		return { version, planHash, planJson, ...carried }
	})()
}
