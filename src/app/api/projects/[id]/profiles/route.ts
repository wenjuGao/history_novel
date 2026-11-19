import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { autoSettings } from '@/lib/auto-setup'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { carryOverEventPersons, confirmPersonProfile, eventBroughtPersons, savePersonProfile } from '@/lib/event-persons'
import { ProfileError, generatePersonProfiles, profilePreview, profilesBlockedReason, saveModelProfiles } from '@/lib/person-profiles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

function names(value: unknown) {
	if (!Array.isArray(value)) return undefined
	const list = [...new Set(value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))].slice(0, 60)
	return list.length ? list : undefined
}

// 人物步骤页把每次写操作的响应整份替换进状态，所以 GET 与写操作必须回同一形状，缺字段会让预览计算崩掉。
function statePayload(projectId: string) {
	const persons = eventBroughtPersons(projectId)
	return {
		persons,
		blocked: profilesBlockedReason(projectId),
		preview: profilePreview(projectId),
		allowExternalTransfer: autoSettings(projectId).allowExternalTransfer,
		pending: persons.filter((person) => person.reviewStatus === 'auto').length,
		withoutProfile: persons.filter((person) => person.selected === 1 && !person.personality.trim() && !person.temperament.trim()).length,
	}
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	return NextResponse.json(statePayload(id), { headers: { 'cache-control': 'no-store' } })
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
	const reply = () => ({ ok: true, ...statePayload(id) })
	try {
		if (body.action === 'carry') {
			const result = carryOverEventPersons(id)
			return NextResponse.json({ ...reply(), carryOver: result })
		}
		if (body.action === 'save') {
			const characterId = typeof body.id === 'string' ? body.id.trim() : ''
			const personality = typeof body.personality === 'string' ? body.personality.trim() : ''
			const temperament = typeof body.temperament === 'string' ? body.temperament.trim() : ''
			if (!characterId) throw new Error('请选择人物。')
			if (!personality && !temperament) throw new Error('请至少填写性格或精神风貌。')
			savePersonProfile(id, characterId, personality, temperament)
			return NextResponse.json(reply())
		}
		if (body.action === 'confirm') {
			const characterId = typeof body.id === 'string' ? body.id.trim() : ''
			if (!characterId) throw new Error('请选择人物。')
			confirmPersonProfile(id, characterId)
			return NextResponse.json(reply())
		}
		if (body.action === 'preview') {
			// 预览同时给出整份界面状态与本次勾选的用量，界面无论用哪种形状都不会丢字段。
			const preview = profilePreview(id, names(body.names))
			return NextResponse.json({ ok: true, ...statePayload(id), ...preview })
		}
		if (body.action === 'generate') {
			// 与剧情提案、章纲一致：本次请求显式确认外发，或项目已在自动化设置里长期同意。
			if (body.allowExternalTransfer !== true && !autoSettings(id).allowExternalTransfer) {
				return NextResponse.json({ error: '生成性格与风貌需要把已核对的记事原文发送到百炼，请先明确确认资料外发。' }, { status: 400 })
			}
			const generation = await generatePersonProfiles(id, names(body.names))
			const saved = saveModelProfiles(id, generation.generated)
			return NextResponse.json({
				...reply(),
				generated: generation.generated,
				missing: generation.missing,
				saved,
				usage: generation.usage,
				requestId: generation.requestId,
				estimate: generation.estimate,
			})
		}
		throw new Error('操作无效。')
	} catch (error) {
		if (error instanceof ProfileError) return NextResponse.json({ error: error.message }, { status: error.status })
		const message = error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '保存失败，请检查输入。'
		return NextResponse.json({ error: message }, { status: 400 })
	}
}
