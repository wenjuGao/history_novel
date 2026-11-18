import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest } from '@/lib/security'
import { historicalToAstronomical } from '@/lib/history-time'
import { corpusEventCandidates } from '@/lib/corpus-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

// 读取区间内的真实记事候选：入参是界面填写的历史纪年（公元前为负、无零年），转换成天文纪年后检索带年纪事。
export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	const params = new URL(request.url).searchParams
	const start = Number(params.get('start'))
	const end = Number(params.get('end'))
	if (!Number.isInteger(start) || start === 0 || !Number.isInteger(end) || end === 0) {
		return NextResponse.json({ error: '起止年份必须是非零整数。' }, { status: 400 })
	}
	const limit = Math.min(Math.max(Number(params.get('limit') ?? 40) || 40, 5), 80)
	const result = corpusEventCandidates(id, { startYear: historicalToAstronomical(start), endYear: historicalToAstronomical(end), limit })
	return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
}
