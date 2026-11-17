import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { corpusBooksOverlappingScope, corpusPinning, corpusReady, pinCorpus } from '@/lib/source-text'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

function status(projectId: string) {
	const ready = corpusReady()
	const pinning = corpusPinning(projectId)
	const scope = db.prepare('SELECT start_year AS startYear, end_year AS endYear FROM project_scope WHERE project_id = ?').get(projectId) as
		| { startYear: number; endYear: number }
		| undefined
	const persons = db.prepare("SELECT rows, built_at AS builtAt FROM corpus_state WHERE kind = 'persons'").get() as { rows: number; builtAt: string } | undefined
	return {
		ready: Boolean(ready),
		reportSha256: ready?.sha256 ?? '',
		volumes: ready?.rows ?? 0,
		pinned: Boolean(pinning),
		pinning,
		personsIndexed: Boolean(persons?.rows),
		personsRows: persons?.rows ?? 0,
		personsBuiltAt: persons?.builtAt ?? '',
		scopeBooks: scope ? corpusBooksOverlappingScope(scope.startYear, scope.endYear) : [],
	}
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	return NextResponse.json(status(id), { headers: { 'cache-control': 'no-store' } })
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
	if (body.action !== 'pin') return NextResponse.json({ error: '操作无效。' }, { status: 400 })
	try {
		pinCorpus(id)
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : '固定语料失败。' }, { status: 400 })
	}
	db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
	return NextResponse.json({ ok: true, ...status(id) })
}
