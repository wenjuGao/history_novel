import { convertMobi } from '@/lib/mobi';
import { randomUUID, createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isLoopbackRequest, isSameOriginLoopback } from "@/lib/security";
import { corpusPinning } from "@/lib/source-text";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const limit = 32 * 1024 * 1024;

export async function GET(request: NextRequest, context: Context) {
  if (!isLoopbackRequest(request)) return NextResponse.json({ error: "仅允许本机访问。" }, { status: 403 });
  const { id } = await context.params;
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
  const documents = db.prepare("SELECT id, category, title, filename, sha256, created_at AS createdAt, corpus_ref AS corpusRef FROM documents WHERE project_id = ? ORDER BY corpus_ref IS NOT NULL DESC, created_at DESC").all(id);
  return NextResponse.json({ documents, corpus: corpusPinning(id) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: Context) {
  if (!isSameOriginLoopback(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  const { id } = await context.params;
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit + 65536) return NextResponse.json({ error: "文件不能超过 32 MB。" }, { status: 413 });
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "无法读取上传文件。" }, { status: 400 }); }
  const file = form.get("file");
  const category = form.get("category");
  if (!(file instanceof File) || (category !== "history" && category !== "reference")) return NextResponse.json({ error: "请选择文件和资料类型。" }, { status: 400 });
  if (!/\.(txt|md|mobi)$/i.test(file.name)) return NextResponse.json({ error: "目前支持 TXT、Markdown 和未加密 MOBI；PDF 导入尚未完成。" }, { status: 400 });
  if (file.size === 0 || file.size > limit) return NextResponse.json({ error: "文件不能为空且不能超过 32 MB。" }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (/\.mobi$/i.test(file.name) && category !== 'reference') return NextResponse.json({error:'MOBI 当前仅用于参考小说，请选择参考小说类别。'}, {status:400});
  let content: string;
  if (/\.mobi$/i.test(file.name)) {
    try { content = await convertMobi(bytes); } catch(error) { return NextResponse.json({error:error instanceof Error ? error.message : 'MOBI 转换失败。'}, {status:400}); }
  } else try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return NextResponse.json({ error: "请使用 UTF-8 编码的文本文件。" }, { status: 400 }); }
  if (!content.trim() || content.includes("\u0000")) return NextResponse.json({ error: "文件不含有效文本。" }, { status: 400 });
  const filename = file.name.replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 200);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    db.prepare("INSERT INTO documents (id, project_id, category, title, filename, sha256, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), id, category, filename, filename, sha256, content, new Date().toISOString());
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return NextResponse.json({ error: "该资料已导入此作品。" }, { status: 409 });
    return NextResponse.json({ error: "保存资料失败。" }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
