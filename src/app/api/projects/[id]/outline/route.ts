import { NextResponse, type NextRequest } from 'next/server'
import { getBailianConfiguration } from '@/lib/bailian'
import { billingMode } from '@/lib/bailian-endpoint.mjs'
import { localOutlinePlan } from '@/lib/auto-setup'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { buildGenerationContext, outlineEvidence, projectScope } from '@/lib/plot-events'
import { stampProposal } from '@/lib/proposal-binding'
import { activeReferenceSpec } from '@/lib/reference-spec'
import { commitPlan, parsePlan, PlanVersionError, readPlan, sha256, validPlan } from '@/lib/story-plan'
import {
	estimateFor,
	generateOutline,
	outlineBlockReason,
	outlineModelId,
	outlinePayload,
	outlineSystemPrompt,
	OutlineError,
	unknownEvidenceIds,
} from '@/lib/outline-generate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })

	const configuration = getBailianConfiguration()
	const mode = billingMode(configuration?.baseURL ?? process.env.BAILIAN_BASE_URL)
	const evidence = outlineEvidence(id)
	const current = readPlan(id)
	const committed = current ? parsePlan(current) : null
	const reference = activeReferenceSpec(id)
	return NextResponse.json(
		{
			blocked: outlineBlockReason(id),
			scope: projectScope(id),
			evidence,
			generationContext: evidence.length ? buildGenerationContext(id) : null,
			model: configuration?.writingModel ?? outlineModelId,
			billingMode: mode,
			configured: Boolean(configuration),
			plan:
				current && committed
					? {
							version: current.version,
							origin: committed.origin ?? 'manual',
							chapters: committed.chapters.length,
							proposal: committed.proposal ? { slot: committed.proposal.slot, revision: committed.proposal.revision } : null,
						}
					: null,
			reference: reference ? { series: reference.series, specChars: reference.specText.length, drift: reference.drift } : null,
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

	const blocked = outlineBlockReason(id)
	if (blocked) return NextResponse.json({ error: blocked }, { status: 409 })

	const planned = body.plannedChapters === undefined ? 8 : Number(body.plannedChapters)
	if (!Number.isInteger(planned) || planned < 1 || planned > 24) {
		return NextResponse.json({ error: '计划章节数需为 1 至 24 的整数。' }, { status: 400 })
	}

	const payload = outlinePayload(id, planned)
	const userPrompt = JSON.stringify(payload)
	const configuration = getBailianConfiguration()
	const mode = billingMode(configuration?.baseURL ?? process.env.BAILIAN_BASE_URL)
	const estimate = estimateFor(userPrompt, mode, configuration?.writingModel ?? outlineModelId)

	// 默认只预览：先把将要外发的内容与用量上限摊开，授权之前不发送任何请求。
	if (body.action === 'skeleton') {
		// REQ-056：按选定提案重排本地骨架章纲，零 Token、不外发，且只作为待确认草稿。
		const skeleton = localOutlinePlan(id, planned)
		if (!skeleton) return NextResponse.json({ error: '没有可用的已采用事件，无法编排本地骨架章纲。' }, { status: 409 })
		const current = readPlan(id)
		const hash = sha256(JSON.stringify(skeleton))
		if (current && current.plan_hash === hash) {
			return NextResponse.json({ version: current.version, planHash: current.plan_hash, origin: 'local', chapters: skeleton.chapters.length, committed: false })
		}
		try {
			const result = commitPlan(id, skeleton, current?.version ?? 0)
			return NextResponse.json({ version: result.version, planHash: result.planHash, origin: 'local', chapters: skeleton.chapters.length, committed: true })
		} catch (error) {
			if (error instanceof PlanVersionError) return NextResponse.json({ error: error.message }, { status: 409 })
			return NextResponse.json({ error: error instanceof Error ? error.message : '无法保存本地骨架章纲。' }, { status: 400 })
		}
	}
	if (body.action !== 'generate') {
		return NextResponse.json({ dryRun: true, prompt: { system: outlineSystemPrompt, user: payload }, estimate })
	}
	if (body.allowExternalTransfer !== true) {
		return NextResponse.json({ error: '生成大纲需要把已核定的史料片段发送到百炼，请先明确确认资料外发。' }, { status: 400 })
	}

	try {
		return NextResponse.json(await generateOutline(id, { plannedChapters: planned }))
	} catch (error) {
		if (error instanceof OutlineError) return NextResponse.json({ error: error.message }, { status: error.status })
		return NextResponse.json({ error: '大纲生成请求状态未知；未写入任何规划，请先核对百炼请求记录。' }, { status: 502 })
	}
}

export async function PUT(request: NextRequest, context: Context) {
	if (!isSameOriginLoopback(request)) return NextResponse.json({ error: '请求来源无效。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })

	let body: { expectedVersion?: unknown; plan?: unknown }
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: '请求内容无效。' }, { status: 400 })
	}
	if (!validPlan(body.plan)) return NextResponse.json({ error: '章节目录结构无效。' }, { status: 400 })

	const blocked = outlineBlockReason(id)
	if (blocked) return NextResponse.json({ error: blocked }, { status: 409 })

	const unknown = unknownEvidenceIds(body.plan, id)
	if (unknown.length) return NextResponse.json({ error: `大纲引用了不存在的证据编号：${unknown.join('、')}。` }, { status: 400 })

	// REQ-051：新版本会撤销上一次人工确认，因此缺少或不符预期版本一律拒绝，不回退成「按当前版本覆盖」。
	const expected = Number(body.expectedVersion)
	if (!Number.isInteger(body.expectedVersion) || expected < 0) {
		return NextResponse.json({ error: '保存章纲必须携带预期版本号，请重新载入后再保存。' }, { status: 400 })
	}

	const plan = stampProposal(id, { ...body.plan, schemaVersion: 2, origin: body.plan.origin ?? 'manual', generationContext: buildGenerationContext(id)! })
	const current = readPlan(id)
	// 证据编号是位置式的：同一编号在新版指向不同证据时显式提示，避免旧方案引用静默改指其他条目。
	// 新版本会使既有确认失效，此处警示作者逐条核对引用后再重新确认。
	const evidenceShift: string[] = []
	if (current) {
		const committed = parsePlan(current)
		const oldMap = new Map((committed.generationContext?.evidence ?? []).map((item) => [item.id, item.title]))
		for (const item of plan.generationContext?.evidence ?? []) {
			const oldTitle = oldMap.get(item.id)
			if (oldTitle !== undefined && oldTitle !== item.title) evidenceShift.push(`${item.id} 原「${oldTitle}」→ 现「${item.title}」`)
		}
	}
	try {
		const result = commitPlan(id, plan, expected)
		return NextResponse.json({ version: result.version, planHash: result.planHash, approval: null, chapters: [], evidenceShift })
	} catch (error) {
		if (error instanceof PlanVersionError) return NextResponse.json({ error: error.message }, { status: 409 })
		const message = error instanceof Error ? error.message : '无法保存章节目录。'
		return NextResponse.json({ error: message }, { status: 400 })
	}
}
