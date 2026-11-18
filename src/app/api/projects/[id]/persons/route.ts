import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { corpusPersonCandidates, importCorpusPersons } from '@/lib/corpus-persons'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

function projectExists(projectId: string) {
	return Boolean(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId))
}

function names(value: unknown, field: string) {
	if (!Array.isArray(value)) throw new Error(`请选择${field}。`)
	const list = [...new Set(value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))]
	if (!list.length) throw new Error(`请选择${field}。`)
	if (list.length > 60) throw new Error(`${field}最多 60 位。`)
	return list
}

export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!projectExists(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') ?? 120) || 120, 20), 400)
	const scope = db.prepare('SELECT start_year AS startYear, end_year AS endYear, region FROM project_scope WHERE project_id = ?').get(id)
	const { books, candidates, pending, defaults, blocked, ready } = corpusPersonCandidates(id, { limit })
	const known = new Set((db.prepare('SELECT name FROM characters WHERE project_id = ?').all(id) as Array<{ name: string }>).map((row) => row.name))
	const withState = (list: typeof candidates) => list.map((candidate) => ({ ...candidate, imported: known.has(candidate.name) }))
	return NextResponse.json(
		{ scope: scope ?? null, books, defaults, blocked, ready, candidates: withState(candidates), pending: withState(pending) },
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
		if (body.action === 'import') {
			const selected = Array.isArray(body.selectedNames) ? new Set(names(body.selectedNames, '默认勾选的史料人物')) : new Set<string>()
			const result = importCorpusPersons(id, names(body.names, '史料人物'), { selectedNames: selected })
			return NextResponse.json({ ok: true, ...result })
		}
		if (body.action === 'block') {
			const list = names(body.names, '要忽略的史料人物')
			db.transaction(() => {
				for (const name of list) db.prepare('INSERT OR IGNORE INTO corpus_person_blocks(project_id, name, created_at) VALUES (?, ?, ?)').run(id, name, now)
				// 忽略即同时取消勾选并移除未确认的自动导入，避免候选与已有人物互相矛盾。
				db.prepare("DELETE FROM characters WHERE project_id = ? AND review_status = 'auto' AND name IN (" + list.map(() => '?').join(',') + ')').run(id, ...list)
				db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
			})()
			return NextResponse.json({ ok: true })
		}
		if (body.action === 'unblock') {
			const list = names(body.names, '要恢复的史料人物')
			db.transaction(() => {
				for (const name of list) db.prepare('DELETE FROM corpus_person_blocks WHERE project_id = ? AND name = ?').run(id, name)
				db.prepare('UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
			})()
			return NextResponse.json({ ok: true })
		}
		throw new Error('操作无效。')
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '保存失败，请检查输入。' }, { status: 400 })
	}
}
