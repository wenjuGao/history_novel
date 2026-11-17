import { redirect } from "next/navigation";
import { getProject, resolveProjectEntry } from "@/lib/projects";

/** 作品入口：新作品进入范围设置；已有作品回到首个未完成步骤或章节目录。 */
export default async function ProjectEntryPage({
	params,
}: {
	params: Promise<{ projectId: string }>;
}) {
	const { projectId } = await params;
	const project = getProject(projectId);
	if (!project) {
		// 布局已校验；此处兜底，避免直达本页时渲染空内容。
		redirect("/");
	}
	const entry = resolveProjectEntry(projectId);
	redirect(entry === "chapters" ? `/projects/${projectId}/chapters` : `/projects/${projectId}/setup/${entry}`);
}
