import { POST as updateSetup } from '../setup/route';
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security';
export const runtime = 'nodejs';
type Context = { params: Promise<{id: string}> };
export async function GET(request: NextRequest, context: Context) {
  if (!isLoopbackRequest(request)) return NextResponse.json({error: '仅允许本机访问。'}, {status: 403});
  const {id} = await context.params;
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) return NextResponse.json({error: '作品不存在。'}, {status: 404});
  return NextResponse.json({ characters: db.prepare('SELECT c.id, c.name, c.evidence, c.selected, d.title AS source FROM characters c JOIN documents d ON d.id = c.document_id WHERE c.project_id = ? ORDER BY c.created_at').all(id) });
}
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOriginLoopback(request)) return NextResponse.json({error: '请求来源无效。'}, {status: 403});
  const {id} = await context.params;
  let body: {name?: unknown; documentId?: unknown; evidence?: unknown};
  try { body = await request.json(); } catch { return NextResponse.json({error: '请求无效。'}, {status: 400}); }
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || typeof body.documentId !== 'string' || typeof body.evidence !== 'string' || !body.evidence.trim() || body.evidence.length > 1000) return NextResponse.json({error: '请填写人物名称和原文证据。'}, {status: 400});
  const source = db.prepare("SELECT content FROM documents WHERE id = ? AND project_id = ? AND category = 'history'").get(body.documentId, id) as {content: string} | undefined;
  if (!source || !source.content.includes(body.evidence.trim())) return NextResponse.json({error: '证据必须是所选历史资料中的原文。'}, {status: 400});
  db.prepare('INSERT INTO characters (id, project_id, name, document_id, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, body.name.trim(), body.documentId, body.evidence.trim(), new Date().toISOString());
  return NextResponse.json({ok: true}, {status: 201});
}
export async function PATCH(request: NextRequest, context: Context) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({error:'请求无效。'}, {status:400}); }
  const { NextRequest: Request } = await import('next/server');
  return updateSetup(new Request(request.url, {method:'POST',headers:request.headers,body:JSON.stringify({...body,action:'select'})}), context);
}
