import 'server-only'

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'

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
		!Array.isArray(plan.chapters) || plan.chapters.length < 1 || plan.chapters.length > 50 ||
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

// Approval rows are keyed by (project_id, plan_version), so any new version silently revokes
// the previous human confirmation; chapter drafts stay bound to their own version.
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
			return { version: 1, planHash, planJson }
		}
		if (expectedVersion !== null && expectedVersion !== current.version) throw new PlanVersionError()
		if (db.prepare("SELECT chapter_id FROM chapter_drafts WHERE project_id = ? AND status = 'generating'").get(projectId)) {
			throw new Error('章节正在生成，请等待本次任务结束后再修改规划。')
		}
		const version = current.version + 1
		db.prepare('INSERT INTO story_plan_revisions(project_id, version, plan_json, plan_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, version, planJson, planHash, now)
		db.prepare('UPDATE story_plans SET version = ?, plan_json = ?, plan_hash = ?, updated_at = ? WHERE project_id = ?').run(version, planJson, planHash, now, projectId)
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
		return { version, planHash, planJson }
	})()
}
