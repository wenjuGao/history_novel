"use client";

import { useParams } from "next/navigation";
import { ChapterWorkspace } from "@/components/chapter-workspace";

export default function ChaptersPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto w-full max-w-[72rem] px-6 py-6">
			<ChapterWorkspace projectId={projectId} />
		</div>
	);
}
