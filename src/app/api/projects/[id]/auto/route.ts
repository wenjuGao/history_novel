import { NextResponse, type NextRequest } from 'next/server'
import { getBailianConfiguration } from '@/lib/bailian'
import { db } from '@/lib/db'
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security'
import { autoSettings, confirmAndGenerate, latestAutoRun, saveAutoSettings, type AutoSettings } from '@/lib/auto-setup'
import { corpusReady } from '@/lib/source-text'
import { storedEvents } from '@/lib/plot-events'

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

	const persons = db.prepare("SELECT rows, built_at AS builtAt FROM corpus_state WHERE kind = 'persons'").get() as
		| { rows: number; builtAt: string }
		| undefined
	const events = storedEvents(id)
	return NextResponse.json(
		{
			settings: autoSettings(id),
			lastRun: latestAutoRun(id),
			status: {
				corpusReady: corpusReady(),
				scope: db.prepare('SELECT start_year AS startYear, end_year AS endYear, region FROM project_scope WHERE project_id = ?').get(id) ?? null,
				selectedCharacters: (db.prepare('SELECT name FROM characters WHERE project_id = ? AND selected = 1').all(id) as Array<{ name: string }>).map(
					(row) => row.name,
				),
				adoptedEvents: events.filter((event) => event.status === 'adopted').length,
				pendingReviewEvents: events.filter((event) => event.status === 'adopted' && event.needsReview).length,
				planVersion: (db.prepare('SELECT version FROM story_plans WHERE project_id = ?').get(id) as { version: number } | undefined)?.version ?? 0,
			},
			modelConfigured: Boolean(getBailianConfiguration()),
			personsIndexed: (persons?.rows ?? 0) > 0,
			personsBuiltAt: persons?.builtAt ?? null,
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

	try {
		if (body.action === 'settings') {
			const patch: Partial<AutoSettings> = {}
			if (body.outlineMode === 'local' || body.outlineMode === 'model' || body.outlineMode === 'off') patch.outlineMode = body.outlineMode
			if (typeof body.allowExternalTransfer === 'boolean') patch.allowExternalTransfer = body.allowExternalTransfer
			if (body.tokenCeiling !== undefined) patch.tokenCeiling = Math.max(Number(body.tokenCeiling) || 0, 0)
			if (body.maxCharacters !== undefined) patch.maxCharacters = Math.min(Math.max(Number(body.maxCharacters) || 12, 2), 60)
			return NextResponse.json({ ok: true, settings: saveAutoSettings(id, patch) })
		}
		if (body.action === 'generate') {
			const run = await confirmAndGenerate(id, {
				startYear: Number(body.startYear),
				endYear: Number(body.endYear),
				region: typeof body.region === 'string' ? body.region : '',
				characterNames: Array.isArray(body.characterNames) ? body.characterNames.map((item) => String(item)) : undefined,
				plannedChapters: body.plannedChapters === undefined ? undefined : Number(body.plannedChapters),
				maxEvents: body.maxEvents === undefined ? undefined : Number(body.maxEvents),
			})
			return NextResponse.json({ ok: true, run })
		}
		throw new Error('操作无效。')
	} catch (error) {
		const message = error instanceof Error && !/SQLITE|constraint|database/i.test(error.message) ? error.message : '自动生成失败，请检查输入。'
		const status = error instanceof Error && 'status' in error && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 400
		return NextResponse.json({ error: message }, { status })
	}
}
