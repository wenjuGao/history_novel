import { notFound } from "next/navigation";
import { readPlan, parsePlan } from "@/lib/story-plan";
import { ChapterReader } from "@/components/chapter-reader";

/** 章节正文直达：校验章节归属当前作品，跨作品或不存在章节一律 404。 */
export default async function ChapterPage({
	params,
}: {
	params: Promise<{ projectId: string; chapterId: string }>;
}) {
	const { projectId, chapterId } = await params;
	const row = readPlan(projectId);
	if (!row) notFound();
	// plan_json 损坏或结构不完整时按章节不存在处理，不让直达路由抛 500。
	let plan: ReturnType<typeof parsePlan>;
	try {
		plan = parsePlan(row);
	} catch {
		notFound();
	}
	if (!Array.isArray(plan.chapters) || !plan.chapters.some((chapter) => chapter.id === chapterId)) notFound();

	return <ChapterReader projectId={projectId} chapterId={chapterId} />;
}
