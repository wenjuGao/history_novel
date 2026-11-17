import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { activeReferenceSpec, confirmProjectSpec, pinReferenceSeries, projectSpecVersions, registeredReferenceSeries, saveProjectSpec } from '@/lib/reference-spec'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	const pinned = activeReferenceSpec(id)
	const specVersions = projectSpecVersions(id)
	return NextResponse.json(
		{
			registered: registeredReferenceSeries(),
			pinned: pinned ? { ...pinned, specChars: pinned.specText.length } : null,
			// 作品规格版本：编辑产生草稿，确认后进入大纲与正文请求；原文永不外发。
			specVersions: specVersions.map((version) => ({
				version: version.version,
				specChars: version.specText.length,
				origin: version.origin,
				confirmedAt: version.confirmedAt,
				createdAt: version.createdAt,
			})),
			currentSpec: specVersions.at(-1)?.specText ?? '',
			uploads: db.prepare("SELECT id, title FROM documents WHERE project_id = ? AND category = 'reference' ORDER BY created_at DESC").all(id),
			// 固定资料只用抽象写作规格；原文始终留在本机，不进入任何生成上下文。
			usage: '参考小说仅贡献视角、节奏、伏笔、对白等抽象方法；生成内容不会包含其原文片段。',
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
	const now = new Date().toISOString()
	try {
		if (body.action === 'pin') {
			const seriesKey = typeof body.seriesKey === 'string' && body.seriesKey.trim() ? body.seriesKey.trim() : undefined
			const series = pinReferenceSeries(id, seriesKey)
			db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
			return NextResponse.json({ ok: true, pinned: activeReferenceSpec(id), series: series.name })
		}
		if (body.action === 'clear') {
			if (!db.prepare('DELETE FROM project_reference WHERE project_id = ?').run(id).changes) throw new Error('本项目尚未固定参考小说。')
			db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
			return NextResponse.json({ ok: true, pinned: null })
		}
		if (body.action === 'saveSpec') {
			if (typeof body.specText !== 'string') throw new Error('请填写规格内容。')
			const result = saveProjectSpec(id, body.specText, Array.isArray(body.methods) ? body.methods.map((item) => String(item)) : undefined)
			return NextResponse.json({ ok: true, version: result.version })
		}
		if (body.action === 'confirmSpec') {
			const version = Number(body.version)
			if (!Number.isInteger(version) || version < 1) throw new Error('规格版本无效。')
			const result = confirmProjectSpec(id, version)
			return NextResponse.json({ ok: true, version: result.version, confirmedAt: result.confirmedAt })
		}
		throw new Error('操作无效。')
	} catch (error) {
		// 两个面板同时编辑确认时，版本号主键冲突属于并发冲突，不是输入错误。
		if (error instanceof Error && /UNIQUE constraint failed: project_reference_spec/.test(error.message)) {
			return NextResponse.json({ error: '规格版本已变化，请重新载入后再保存。' }, { status: 409 })
		}
		return NextResponse.json(
			{ error: error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '保存失败，请检查输入。' },
			{ status: 400 },
		)
	}
}
