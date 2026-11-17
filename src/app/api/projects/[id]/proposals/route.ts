import { NextResponse, type NextRequest } from 'next/server'
import { getBailianConfiguration } from '@/lib/bailian'
import { billingMode } from '@/lib/bailian-endpoint.mjs'
import { db } from '@/lib/db'
import { proposalInputHash } from '@/lib/proposal-binding'
import { buildGenerationContext, outlineEvidence } from '@/lib/plot-events'
import {
	ProposalError,
	clearSelectedProposal,
	editProposal,
	generateModelProposals,
	listProposals,
	localProposalDrafts,
	proposalEstimateFor,
	proposalHistory,
	proposalPayload,
	proposalSystemPrompt,
	proposalsBlockedReason,
	replaceUnselectedProposals,
	selectProposal,
	type ProposalDraft,
} from '@/lib/plot-proposals'
import { activeReferenceSpec } from '@/lib/reference-spec'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

function readDraft(value: unknown): ProposalDraft | null {
	if (!value || typeof value !== 'object') return null
	const source = value as Record<string, unknown>
	const list = (item: unknown) => (Array.isArray(item) ? item.filter((entry) => typeof entry === 'string').map((entry) => (entry as string).trim().slice(0, 2000)).filter(Boolean) : null)
	const title = typeof source.title === 'string' ? source.title.trim() : ''
	const viewpoint = typeof source.viewpoint === 'string' ? source.viewpoint.trim() : ''
	const mainLine = typeof source.mainLine === 'string' ? source.mainLine.trim() : ''
	const conflicts = list(source.conflicts)
	const fiction = list(source.fiction)
	const evidence = list(source.evidence)
	if (!title || title.length > 120 || !viewpoint || viewpoint.length > 300 || !mainLine || mainLine.length > 4000) return null
	if (!conflicts?.length || !fiction?.length || !evidence?.length) return null
	const synopsis = typeof source.synopsis === 'string' ? source.synopsis : ''
	if (synopsis.length > 6000 || conflicts.length > 20 || fiction.length > 20 || evidence.length > 40) return null
	return { title, viewpoint, mainLine, synopsis, conflicts, fiction, evidence }
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })

	const configuration = getBailianConfiguration()
	const mode = billingMode(configuration?.baseURL ?? process.env.BAILIAN_BASE_URL)
	const generation = buildGenerationContext(id)
	const proposals = listProposals(id)
	const reference = activeReferenceSpec(id)
	const userPrompt = generation ? JSON.stringify(proposalPayload(id, generation)) : ''
	return NextResponse.json(
		{
			blocked: proposalsBlockedReason(id),
			inputHash: proposalInputHash(id),
			evidence: outlineEvidence(id).map((item) => ({ id: item.id, title: item.event.title })),
			proposals,
			selected: proposals.find((proposal) => proposal.status === 'selected') ?? null,
			history: proposals.map((proposal) => ({ slot: proposal.slot, revisions: proposalHistory(id, proposal.slot) })),
			model: configuration?.writingModel ?? null,
			billingMode: mode,
			configured: Boolean(configuration),
			estimate: userPrompt ? proposalEstimateFor(userPrompt, mode, configuration?.writingModel ?? 'qwen3.8-max') : null,
			specVersion: reference?.version ?? null,
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

	const action = typeof body.action === 'string' ? body.action : ''

	if (action === 'save' || action === 'select' || action === 'unselect') {
		const slot = Number(body.slot)
		if (!Number.isInteger(slot) || slot < 1 || slot > 3) return NextResponse.json({ error: '提案编号需为 1 至 3 的整数。' }, { status: 400 })
		try {
			if (action === 'save') {
				const draft = readDraft(body.proposal)
				if (!draft) return NextResponse.json({ error: '提案内容不完整：标题、视角、主线、冲突、虚构边界与证据编号都必须填写。' }, { status: 400 })
				const known = new Set(outlineEvidence(id).map((item) => item.id))
				const unknown = draft.evidence.filter((item) => !known.has(item))
				if (unknown.length) return NextResponse.json({ error: `提案引用了不存在的证据编号：${unknown.join('、')}。` }, { status: 400 })
				return NextResponse.json({ proposal: editProposal(id, slot, draft), proposals: listProposals(id) })
			}
			if (action === 'select') return NextResponse.json({ selected: selectProposal(id, slot), proposals: listProposals(id) })
			clearSelectedProposal(id)
			return NextResponse.json({ proposals: listProposals(id) })
		} catch (error) {
			const message = error instanceof Error ? error.message : '提案操作失败。'
			return NextResponse.json({ error: message }, { status: 409 })
		}
	}

	const blocked = proposalsBlockedReason(id)
	if (blocked) return NextResponse.json({ error: blocked }, { status: 409 })

	const configuration = getBailianConfiguration()
	const mode = billingMode(configuration?.baseURL ?? process.env.BAILIAN_BASE_URL)
	const payload = proposalPayload(id, buildGenerationContext(id)!)
	const userPrompt = JSON.stringify(payload)
	const estimate = proposalEstimateFor(userPrompt, mode, configuration?.writingModel ?? 'qwen3.8-max')

	// 默认 dry run：先把将要外发的内容与用量上限摊开看，预览不发送任何请求。
	if (action !== 'local' && action !== 'generate') {
		return NextResponse.json({ dryRun: true, prompt: { system: proposalSystemPrompt, user: payload }, estimate })
	}

	if (action === 'local') {
		const drafts = localProposalDrafts(id)
		if (!drafts.length) return NextResponse.json({ error: '没有可用的已采用事件，无法拼装本地提案。' }, { status: 409 })
		return NextResponse.json({ proposals: replaceUnselectedProposals(id, drafts, 'local', null), source: 'local', usedModel: false })
	}

	if (body.allowExternalTransfer !== true) {
		return NextResponse.json({ error: '生成剧情提案需要把已核定的史料片段发送到百炼，请先明确确认资料外发。' }, { status: 400 })
	}
	try {
		return NextResponse.json(await generateModelProposals(id))
	} catch (error) {
		if (error instanceof ProposalError) return NextResponse.json({ error: error.message }, { status: error.status })
		return NextResponse.json({ error: '剧情提案请求状态未知；未写入任何提案，请先核对百炼请求记录。' }, { status: 502 })
	}
}
