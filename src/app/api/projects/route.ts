import { NextResponse, type NextRequest } from "next/server";
import { createProject, listProjects } from "@/lib/projects";
import { isLoopbackRequest, isSameOriginLoopback } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json({ error: "仅允许本机访问。" }, { status: 403 });
  }
  return NextResponse.json(
    { projects: listProjects() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isSameOriginLoopback(request)) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容必须是 JSON。" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string") {
    return NextResponse.json({ error: "请提供项目名称。" }, { status: 400 });
  }

  try {
    return NextResponse.json({ project: createProject(body.name) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法创建项目。";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}