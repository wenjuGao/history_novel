import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isLoopbackRequest } from '@/lib/security'
import { charactersForEventKeys } from '@/lib/corpus-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

// 勾选记事带出的人物预览：按人名跨记事去重，零 Token、只读，采用前让作者看到会新增哪些人。
// keys 为候选列表里的记事键（corpus:…），一次最多回读 100 条，与批量采用的上限一致。
export async function GET(request: NextRequest, context: Context) {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: '仅允许本机访问。' }, { status: 403 })
	const { id } = await context.params
	if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) return NextResponse.json({ error: '作品不存在。' }, { status: 404 })
	const keys = (new URL(request.url).searchParams.get('keys') ?? '')
		.split(',')
		.map((key) => key.trim())
		.filter(Boolean)
		.slice(0, 100)
	return NextResponse.json(
		{ persons: charactersForEventKeys(id, keys), events: keys.length },
		{ headers: { 'cache-control': 'no-store' } },
	)
}
