"use client";

import { ChapterWorkspace } from "@/components/chapter-workspace";

/** 章节正文直达：初始进入正文视图并定位到指定章节。 */
export function ChapterReader({ projectId, chapterId }: { projectId: string; chapterId: string }) {
	return (
		<div className="mx-auto flex h-full min-h-0 w-full max-w-[72rem] flex-col px-6 py-6">
			<ChapterWorkspace projectId={projectId} initialChapterId={chapterId} initialView="reading" />
		</div>
	);
}
