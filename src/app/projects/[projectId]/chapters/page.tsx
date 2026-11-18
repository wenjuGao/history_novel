"use client";

import { useParams } from "next/navigation";
import { ChapterWorkspace } from "@/components/chapter-workspace";

export default function ChaptersPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto flex h-full min-h-0 w-full max-w-[72rem] flex-col px-6 py-6">
			<ChapterWorkspace projectId={projectId} />
		</div>
	);
}
