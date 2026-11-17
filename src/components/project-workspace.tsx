"use client";

import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenText } from "lucide-react";
import { cn } from "@/lib/utils";
import { StoryProvider } from "@/components/story-provider";
import type { ProjectSummary } from "@/components/create-project-dialog";

type ProjectValue = {
	project: ProjectSummary;
};

const ProjectContext = createContext<ProjectValue | null>(null);

export function useProject() {
	const value = useContext(ProjectContext);
	if (!value) throw new Error("useProject 必须在 ProjectWorkspace 内使用。");
	return value;
}

const steps: Array<{ slug: string; title: string }> = [
	{ slug: "scope", title: "范围与史料" },
	{ slug: "references", title: "参考资料" },
	{ slug: "persons", title: "人物" },
	{ slug: "events", title: "事件" },
	{ slug: "proposals", title: "剧情提案" },
	{ slug: "outline", title: "章纲" },
];

/** 作品域布局：URL 中的作品 ID 为唯一真源，切作品整树重建（StoryProvider key）。 */
export function ProjectWorkspace({
	project,
	updatedAtLabel,
	children,
}: {
	project: ProjectSummary;
	/** 服务端格式化的更新时间，避免客户端 hydration 差异。 */
	updatedAtLabel: string;
	children: ReactNode;
}) {
	const pathname = usePathname();
	const base = `/projects/${project.id}`;

	return (
		<ProjectContext.Provider value={{ project }}>
			<StoryProvider key={project.id} projectId={project.id}>
				<div className="flex h-full min-h-0 flex-col">
					<header className="flex shrink-0 flex-col gap-2.5 border-b border-border bg-surface px-6 py-3">
						<div className="flex min-w-0 items-center justify-between gap-4">
							<div className="flex min-w-0 items-center gap-2.5">
								<span className="grid size-8 shrink-0 place-items-center rounded-sm bg-primary font-serif text-[13px] text-primary-foreground">
									稿
								</span>
								<div className="flex min-w-0 flex-col">
									<h1 className="truncate font-serif text-[16px] leading-tight text-foreground">{project.name}</h1>
									<p className="text-[11px] text-muted-foreground">
										第 {project.version} 版 · 更新于 {updatedAtLabel}
									</p>
								</div>
							</div>
							<Link
								href="/"
								className="shrink-0 rounded-sm border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-muted"
							>
								返回概览
							</Link>
						</div>
						<nav aria-label="作品步骤导航">
							<ol className="flex min-w-0 items-center gap-1 overflow-x-auto">
								{steps.map((step, index) => {
									const href = `${base}/setup/${step.slug}`;
									const active = pathname === href;
									return (
										<li key={step.slug} className="flex items-center gap-1">
											<Link
												href={href}
												aria-current={active ? "page" : undefined}
												className={cn(
													"flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[12px] transition-colors",
													active
														? "bg-primary/10 font-medium text-primary ring-1 ring-primary/25 ring-inset"
														: "text-muted-foreground hover:bg-muted hover:text-foreground",
												)}
											>
												<span className="font-mono text-[10px]">{String(index + 1).padStart(2, "0")}</span>
												{step.title}
											</Link>
											<span aria-hidden className="text-[10px] text-muted-foreground/60">›</span>
										</li>
									);
								})}
								<li>
									<Link
										href={`${base}/chapters`}
										aria-current={pathname.startsWith(`${base}/chapters`) ? "page" : undefined}
										className={cn(
											"flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[12px] transition-colors",
											pathname.startsWith(`${base}/chapters`)
												? "bg-primary/10 font-medium text-primary ring-1 ring-primary/25 ring-inset"
												: "text-muted-foreground hover:bg-muted hover:text-foreground",
										)}
									>
										<BookOpenText size={14} strokeWidth={1.8} />
										章节目录与正文
									</Link>
								</li>
							</ol>
						</nav>
					</header>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
				</div>
			</StoryProvider>
		</ProjectContext.Provider>
	);
}
