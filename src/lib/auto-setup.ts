import 'server-only'

import { randomUUID } from 'node:crypto'
import { getBailianConfiguration } from '@/lib/bailian'
import { historicalToAstronomical } from '@/lib/history-time'
import { corpusBooksForScope, corpusPersonCandidates, corpusPersonPairs, importCorpusPersons } from '@/lib/corpus-persons'
import { buildGenerationContext, derivedCandidates, outlineEvidence } from '@/lib/plot-events'
import { proposalGateReason, stampProposal } from '@/lib/proposal-binding'
import { assertEvidenceInSource, corpusDocumentIds } from '@/lib/source-text'
import { generateOutline, OutlineError } from '@/lib/outline-generate'
import { commitPlan, readPlan, sha256, validPlan, type StoryPlan } from '@/lib/story-plan'
import { db } from '@/lib/db'

// 时间阶段与人物确认之后的一次性收敛：写入范围、导入史料人物与强关联待核线索、准备派生事件候选，
// 先落一版本地骨架大纲；只有项目已存同意资料外发且配置了百炼 Key 时，才再调用模型大纲覆盖它。
// 事件不自动采用、auto 关系不代填年份——都待作者逐条核对原文后确认。章节正文不在这里生成。

export type AutoSettings = {
	outlineMode: 'local' | 'model' | 'off'
	allowExternalTransfer: boolean
	tokenCeiling: number
	maxCharacters: number
}

const defaults: AutoSettings = { outlineMode: 'model', allowExternalTransfer: false, tokenCeiling: 0, maxCharacters: 12 }

export function autoSettings(projectId: string): AutoSettings {
	const row = db
		.prepare('SELECT outline_mode, allow_external_transfer, token_ceiling, max_characters FROM project_auto_settings WHERE project_id = ?')
		.get(projectId) as { outline_mode: string; allow_external_transfer: number; token_ceiling: number; max_characters: number } | undefined
	if (!row) return defaults
	return {
		outlineMode: row.outline_mode === 'local' || row.outline_mode === 'off' ? row.outline_mode : 'model',
		allowExternalTransfer: row.allow_external_transfer === 1,
		tokenCeiling: row.token_ceiling,
		maxCharacters: row.max_characters,
	}
}

export function saveAutoSettings(projectId: string, patch: Partial<AutoSettings>) {
	const current = autoSettings(projectId)
	const next: AutoSettings = { ...current, ...patch }
	db.prepare(
		`INSERT INTO project_auto_settings(project_id, outline_mode, allow_external_transfer, token_ceiling, max_characters, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET outline_mode = excluded.outline_mode, allow_external_transfer = excluded.allow_external_transfer,
			token_ceiling = excluded.token_ceiling, max_characters = excluded.max_characters, updated_at = excluded.updated_at`,
	).run(projectId, next.outlineMode, next.allowExternalTransfer ? 1 : 0, next.tokenCeiling, next.maxCharacters, new Date().toISOString())
	return next
}

export type AutoRunSummary = {
	id: string
	runAt: string
	status: 'ok' | 'partial' | 'failed'
	input: Record<string, unknown>
	result: AutoSetupResult
	error: string
}

export function latestAutoRun(projectId: string): AutoRunSummary | null {
	const row = db
		.prepare('SELECT id, run_at, status, input_json, result_json, error FROM auto_runs WHERE project_id = ? ORDER BY run_at DESC LIMIT 1')
		.get(projectId) as { id: string; run_at: string; status: string; input_json: string; result_json: string; error: string } | undefined
	if (!row) return null
	let result: AutoSetupResult
	try {
		result = JSON.parse(row.result_json) as AutoSetupResult
	} catch {
		result = { steps: [], status: 'partial' }
	}
	return { id: row.id, runAt: row.run_at, status: row.status as AutoRunSummary['status'], input: safeJson(row.input_json), result, error: row.error }
}

function safeJson(value: string) {
	try {
		return JSON.parse(value) as Record<string, unknown>
	} catch {
		return {}
	}
}

export type AutoSetupStep = { key: string; ok: boolean; detail: string }

export type AutoSetupResult = {
	status?: 'ok' | 'partial' | 'failed'
	steps: AutoSetupStep[]
	scope?: { startYear: number; endYear: number; region: string }
	characters?: { imported: string[]; selected: string[]; skipped: Array<{ name: string; reason: string }> }
	relations?: number
	events?: { adopted: number; candidates: number }
	plan?: { version: number; chapters: number; source: 'local' | 'model' }
	outline?: { attempted: boolean; accepted: boolean; issues: string[]; requestId: string | null }
}

export type AutoSetupInput = {
	startYear: number
	endYear: number
	region: string
	characterNames?: string[]
	plannedChapters?: number
	maxEvents?: number
}

function year(value: unknown, field: string) {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed === 0 || Math.abs(parsed) > 10000) throw new Error(`${field}必须是非零整数年份。`)
	return historicalToAstronomical(parsed)
}

const maxAdoptedEvents = 40

export async function confirmAndGenerate(projectId: string, input: AutoSetupInput): Promise<AutoSetupResult> {
	const startYear = year(input.startYear, '起始年份')
	const endYear = year(input.endYear, '结束年份')
	if (startYear > endYear) throw new Error('起始年份不能晚于结束年份。')
	const region = typeof input.region === 'string' ? input.region.trim().slice(0, 200) : ''
	if (!region) throw new Error('请填写地域范围。')
	const plannedChapters = input.plannedChapters === undefined ? 8 : Number(input.plannedChapters)
	if (!Number.isInteger(plannedChapters) || plannedChapters < 1 || plannedChapters > 24) throw new Error('计划章节数需为 1 至 24 的整数。')
	const maxEvents = Math.min(Math.max(Number(input.maxEvents ?? maxAdoptedEvents) || maxAdoptedEvents, 1), maxAdoptedEvents)

	const steps: AutoSetupStep[] = []
	const now = new Date().toISOString()
	db.transaction(() => {
		db.prepare(
			`INSERT INTO project_scope(project_id, start_year, end_year, region) VALUES (?, ?, ?, ?)
			 ON CONFLICT(project_id) DO UPDATE SET start_year = excluded.start_year, end_year = excluded.end_year, region = excluded.region`,
		).run(projectId, startYear, endYear, region)
		db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, projectId)
	})()
	steps.push({ key: 'scope', ok: true, detail: `${startYear}—${endYear} 年，${region}` })

	const settings = autoSettings(projectId)
	const selectedBefore = (db.prepare('SELECT name FROM characters WHERE project_id = ? AND selected = 1 ORDER BY created_at').all(projectId) as Array<{
		name: string
	}>).map((row) => row.name)

	const characters: AutoSetupResult['characters'] = { imported: [], selected: [], skipped: [] }
	let importFailed = false
	try {
		const wanted = Array.isArray(input.characterNames) ? input.characterNames.map((name) => String(name).trim()).filter(Boolean) : []
		const names = wanted.length ? [...new Set(wanted)].slice(0, 60) : corpusPersonCandidates(projectId, { limit: 200 }).defaults
		if (!names.length) throw new Error('当前时间阶段没有可导入的史料人物候选。')
		const result = importCorpusPersons(projectId, names, { selectedNames: new Set(names) })
		characters.imported = result.inserted
		characters.skipped = result.skipped
		characters.selected = [...new Set([...selectedBefore, ...result.inserted])]
		// 重复运行时间样人物全部落到「已有同名人物」，这是幂等结果而不是失败。
		const existingOnly = result.inserted.length === 0 && result.skipped.every((item) => item.reason === '本项目已有同名人物')
		steps.push({
			key: 'characters',
			ok: result.inserted.length > 0 || existingOnly,
			detail: existingOnly
				? `史料人物已在项目内（勾选 ${characters.selected.length} 位）`
				: `新导入 ${result.inserted.length} 位，已勾选 ${characters.selected.length} 位${result.skipped.length ? `，跳过 ${result.skipped.length} 位` : ''}`,
		})
	} catch (error) {
		importFailed = true
		characters.selected = selectedBefore
		steps.push({ key: 'characters', ok: false, detail: error instanceof Error ? error.message : '史料人物导入失败。' })
	}

	let relations = 0
	let relationDuplicates = 0
	const relationIssues: string[] = []
	if (!importFailed) {
		const people = db.prepare('SELECT id, name FROM characters WHERE project_id = ? AND selected = 1 ORDER BY created_at').all(projectId) as Array<{
			id: string
			name: string
		}>
		const byName = new Map(people.map((person) => [person.name, person.id]))
		const existing = new Set(
			(db.prepare('SELECT from_id, to_id FROM historical_relations WHERE project_id = ?').all(projectId) as Array<{ from_id: string; to_id: string }>).map(
				(row) => `${row.from_id}\u0001${row.to_id}`,
			),
		)
		const documentByBook = new Map(
			corpusDocumentIds(projectId, corpusBooksForScope(projectId).map((book) => book.id)).map((row) => [row.bookId, row.id]),
		)
		for (const pair of corpusPersonPairs(projectId, people.map((person) => person.name), { limit: maxEvents })) {
			const fromId = byName.get(pair.from)
			const toId = byName.get(pair.to)
			const documentId = documentByBook.get(pair.bookId)
			if (!fromId || !toId || fromId === toId) continue
			if (existing.has(`${fromId}\u0001${toId}`) || existing.has(`${toId}\u0001${fromId}`)) {
				relationDuplicates += 1
				continue
			}
			if (!documentId || !assertEvidenceInSource(projectId, documentId, pair.evidence).ok) {
				relationIssues.push(`${pair.from}与${pair.to}的证据未命中原文`)
				continue
			}
			db.prepare(
				`INSERT INTO historical_relations (id, project_id, from_id, to_id, label, document_id, evidence, start_year, end_year, review_status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'auto')`,
			).run(randomUUID(), projectId, fromId, toId, `史料同段共现 ${pair.co} 次／${pair.volumes} 卷`.slice(0, 80), documentId, pair.evidence)
			existing.add(`${fromId}\u0001${toId}`)
			relations += 1
		}
		steps.push({
			key: 'relations',
			ok: relationIssues.length === 0,
			detail: relationIssues.length
				? `新增 ${relations} 条强关联，${relationIssues.length} 条证据未命中原文`
				: relations
					? `新增 ${relations} 条强关联`
					: relationDuplicates
						? `强关联关系已存在 ${relationDuplicates} 条，无需新增`
						: '勾选人物之间没有达到强关联阈值的史料共现。',
		})
	}

	let events = { adopted: 0, candidates: 0 }
	if (!importFailed) {
		// 只准备候选，不自动采用：采用须作者逐条核对原文（确认动作记录 verified_at）。
		const candidates = derivedCandidates(projectId)
		events = { adopted: 0, candidates: candidates.length }
		steps.push({
			key: 'events',
			ok: true,
			detail: events.candidates
				? `已准备 ${events.candidates} 个派生事件候选，待人工核对后采用。`
				: '暂无派生事件候选，可先补充史料人物或手工新增事件。',
		})
	}

	let planVersion = 0
	let planChapters = 0
	let planSource: 'local' | 'model' = 'local'
	const outline = { attempted: false, accepted: false, issues: [] as string[], requestId: null as string | null }
	let planFailed = false
	// REQ-056：章纲必须绑定选定提案。未选定时自动流程停在提案步骤，只记录跳过原因，不写无绑定的规划。
	let planSkipped = false
	const proposalBlocked = proposalGateReason(projectId)

	const hasEvidence = outlineEvidence(projectId).length > 0
	if (settings.outlineMode === 'off') {
		steps.push({ key: 'plan', ok: true, detail: '按设置跳过大纲生成，只写入事件与人物。' })
	} else if (proposalBlocked && hasEvidence) {
		planSkipped = true
		steps.push({ key: 'plan', ok: true, detail: `${proposalBlocked}本次未写入规划。` })
	} else if (hasEvidence) {
		let skeleton: StoryPlan | null = null
		try {
			skeleton = localOutlinePlan(projectId, plannedChapters)
		} catch (error) {
			planFailed = true
			steps.push({ key: 'plan', ok: false, detail: error instanceof Error ? error.message : '本地骨架大纲生成失败。' })
		}
		if (!planFailed && !skeleton) {
			planFailed = true
			steps.push({ key: 'plan', ok: false, detail: '已采用事件没有可用的证据编号，未写入规划。' })
		}
		if (!planFailed && skeleton && !validPlan(skeleton)) {
			planFailed = true
			steps.push({ key: 'plan', ok: false, detail: '本地骨架大纲未通过结构校验，未写入规划。' })
		}
		if (!planFailed && skeleton) {
			try {
				const current = readPlan(projectId)
				// 重复运行时若骨架与当前规划完全一致，就不再新增版本，避免无谓地撤销已有的人工批准。
				if (current && current.plan_hash === sha256(JSON.stringify(skeleton))) {
					planVersion = current.version
					planChapters = skeleton.chapters.length
					steps.push({ key: 'plan', ok: true, detail: `本地骨架大纲与 v${current.version} 一致，未新增版本。` })
				} else {
					const committed = commitPlan(projectId, skeleton, current?.version ?? 0)
					planVersion = committed.version
					planChapters = skeleton.chapters.length
					steps.push({ key: 'plan', ok: true, detail: `本地骨架大纲 v${committed.version}：${skeleton.chapters.length} 章` })
				}
			} catch (error) {
				planFailed = true
				steps.push({ key: 'plan', ok: false, detail: error instanceof Error ? error.message : '无法写入本地骨架大纲。' })
			}
		}
	} else if (!importFailed) {
		planFailed = true
		steps.push({ key: 'plan', ok: false, detail: '没有可作为证据采用的事件，暂不生成大纲。' })
	}

	if (planSkipped) {
		steps.push({ key: 'outline', ok: true, detail: '章纲需绑定选定提案，本次未生成大纲。' })
	} else if (settings.outlineMode === 'local' && !planFailed) {
		steps.push({ key: 'outline', ok: true, detail: '按设置只保留本地骨架大纲，不调用模型。' })
	} else if (settings.outlineMode === 'model' && !planFailed) {
		if (!settings.allowExternalTransfer) {
			outline.issues = ['项目未同意资料外发，只生成本地骨架大纲。']
			steps.push({ key: 'outline', ok: true, detail: '按设置保留本地骨架大纲（未外发资料）。' })
		} else if (!getBailianConfiguration()) {
			steps.push({ key: 'outline', ok: false, detail: '未配置百炼 API Key，保留本地骨架大纲。' })
			outline.issues = ['服务端未配置 DASHSCOPE_API_KEY。']
		} else {
			outline.attempted = true
			try {
				const generated = await generateOutline(projectId, { plannedChapters })
				outline.issues = generated.issues
				outline.requestId = generated.requestId
				if (generated.accepted) {
					// 模型大纲覆盖本地骨架：按当前版本做乐观锁检查，与人工保存走同一条版本链。
					const committed = commitPlan(projectId, generated.plan, readPlan(projectId)?.version ?? 0)
					planVersion = committed.version
					planChapters = generated.plan.chapters.length
					planSource = 'model'
					outline.accepted = true
					steps.push({ key: 'outline', ok: true, detail: `模型大纲 v${committed.version}：${generated.plan.chapters.length} 章` })
				} else {
					steps.push({ key: 'outline', ok: false, detail: `模型大纲未通过校验：${generated.issues.join('；')}；保留本地骨架大纲。` })
				}
			} catch (error) {
				outline.issues = [error instanceof OutlineError ? error.message : '大纲生成请求状态未知，请先核对百炼请求记录。']
				steps.push({ key: 'outline', ok: false, detail: `${outline.issues[0]}；保留本地骨架大纲。` })
			}
		}
	}

	const failures = steps.filter((step) => !step.ok).length
	const status: AutoSetupResult['status'] = failures === 0 ? 'ok' : steps.some((step) => step.key === 'plan' && step.ok) ? 'partial' : 'failed'
	const result: AutoSetupResult = {
		status,
		steps,
		scope: { startYear, endYear, region },
		characters,
		relations,
		events,
		plan: planChapters ? { version: planVersion, chapters: planChapters, source: planSource } : undefined,
		outline,
	}
	db.prepare('INSERT INTO auto_runs(id, project_id, run_at, status, input_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
		randomUUID(),
		projectId,
		new Date().toISOString(),
		status,
		JSON.stringify({ ...input, outlineMode: settings.outlineMode, allowExternalTransfer: settings.allowExternalTransfer }),
		JSON.stringify(result),
		steps.filter((step) => !step.ok).map((step) => `${step.key}：${step.detail}`).join('；'),
	)
	db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
	return result
}

// 本地骨架大纲：只按已采用事件的年代顺序分章，每章引用真实存在的证据编号，
// 供人工在模型大纲之前先有一个可核对的时间线；不含任何模型推断的情节。
export function localOutlinePlan(projectId: string, plannedChapters: number): StoryPlan | null {
	const evidence = outlineEvidence(projectId)
	const context = buildGenerationContext(projectId)
	if (!evidence.length || !context) return null
	const scope = context.scope as { startYear: number; endYear: number; regions: string[] }
	const events = evidence.map(({ id, event }) => ({ id, event }))
	const chapterCount = Math.max(1, Math.min(plannedChapters, events.length))
	// 按章数均分事件（余数摊给前几章），避免出现空章节让骨架大纲通不过结构校验。
	const evenSplit = Math.floor(events.length / chapterCount)
	const remainder = events.length % chapterCount
	let cursor = 0
	const slices = Array.from({ length: chapterCount }, (_, index) => {
		const size = evenSplit + (index < remainder ? 1 : 0)
		const slice = events.slice(cursor, cursor + size)
		cursor += size
		return slice
	})

	const chapters = slices.map((slice, index) => {
		const first = slice[0]?.event
		const years = [...new Set(slice.map((item) => (item.event.start === item.event.end ? `${item.event.start}` : `${item.event.start}—${item.event.end}`)))]
		return {
			id: `chapter-${String(index + 1).padStart(2, '0')}`,
			title: `第 ${index + 1} 章 ${first ? first.title.slice(0, 60) : '待补事件'}`.slice(0, 160),
			pov: (first?.participants[0]?.name ?? '').slice(0, 80),
			time: `${years.join('、')} 年 ${first?.region ?? scope.regions.join('、')}`.slice(0, 160),
			synopsis: slice.map((item) => `${item.event.start}—${item.event.end} 年 ${item.event.region}：${item.event.title}`).join('；').slice(0, 4000),
			plot: slice.map((item) => `${item.id} ${item.event.title}：${item.event.summary.slice(0, 160)}`).slice(0, 20),
			historyEvidence: slice.map((item) => item.id),
			fiction: ['本章的场景、对白、心理与细节均为虚构，正文阶段需逐处标注。'],
			endingHook: index === chapterCount - 1 ? '史料记载到此为止，后续走向需人工核定。' : '本章事件在史料中的记载止于此，钩子需在正文阶段补写。',
		}
	})

	return stampProposal(projectId, {
		schemaVersion: 2,
		origin: 'local' as const,
		title: `${scope.regions.join('、')}（${scope.startYear}—${scope.endYear}）本地骨架大纲`.slice(0, 120),
		scope: { period: `${scope.startYear}—${scope.endYear}`, regions: scope.regions, plannedChapters: chapterCount },
		synopsis: `按已采用事件的年代顺序编排 ${chapterCount} 章，人物与冲突由史料派生，尚未经模型扩写。`.slice(0, 10000),
		centralQuestion: `在 ${scope.startYear}—${scope.endYear} 年的${scope.regions.join('、')}，已勾选人物如何在已核定的史实约束下走向史料记载的结局？`.slice(0, 2000),
		historicalAnchors: events.map(({ id, event }) => ({ evidenceId: id, fact: event.evidence.slice(0, 2000) })),
		fictionBoundary: ['史家记言不直接改写成对白。', '史料未载的因果与心理活动一律标为虚构。', '不把范围外的年代与知识写入本章。'],
		chapters,
		humanReviewQuestions: [
			'自动采用的事件是否都存在且年代正确？',
			'强关联关系是否只是同一叙事段落内的共现，而非实际交往？',
			'需要在哪一章补充虚构人物或虚构线？',
		].slice(0, 20),
		generationContext: context,
	})
}
