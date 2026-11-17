import { notFound } from "next/navigation";
import { getProject } from "@/lib/projects";
import { ProjectWorkspace } from "@/components/project-workspace";

/** 作品域隔离边界：projectId 不存在即 404；域内所有取数以路由参数为准。 */
export default async function ProjectLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ projectId: string }>;
}) {
	const { projectId } = await params;
	const project = getProject(projectId);
	if (!project) notFound();
	const updatedAtLabel = new Date(project.updatedAt).toLocaleString("zh-CN");

	return (
		<ProjectWorkspace project={project} updatedAtLabel={updatedAtLabel}>
			{children}
		</ProjectWorkspace>
	);
}
