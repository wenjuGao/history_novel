import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isLoopbackRequest, isSameOriginLoopback } from "@/lib/security";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  if (!isLoopbackRequest(request)) return NextResponse.json({ error: "仅允许本机访问。" }, { status: 403 });
  const { id } = await context.params;
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
  const scope = db.prepare("SELECT start_year AS startYear, end_year AS endYear, region FROM project_scope WHERE project_id = ?").get(id) ?? null;
  return NextResponse.json({ scope }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: NextRequest, context: Context) {
  if (!isSameOriginLoopback(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  const { id } = await context.params;
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
  let body: { startYear?: unknown; endYear?: unknown; region?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "请求内容无效。" }, { status: 400 }); }
  if (!body || !Number.isInteger(body.startYear) || !Number.isInteger(body.endYear) || typeof body.region !== "string" || !body.region.trim() || body.region.trim().length > 200 || (body.startYear as number) > (body.endYear as number) || Math.abs(body.startYear as number) > 10000 || Math.abs(body.endYear as number) > 10000) {
    return NextResponse.json({ error: "请输入有效的起止年份和区域；起始年份不能晚于结束年份。" }, { status: 400 });
  }
  const region = body.region.trim();
  db.transaction(() => {
  db.prepare("INSERT INTO project_scope (project_id, start_year, end_year, region) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET start_year=excluded.start_year, end_year=excluded.end_year, region=excluded.region").run(id, body.startYear, body.endYear, region);
  db.prepare("UPDATE projects SET version=version+1, updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  })();
  return NextResponse.json({ ok: true });
}
