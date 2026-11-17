"use client";

import { useParams } from "next/navigation";
import { OutlinePanel } from "@/components/panels/outline-panel";
import { PlanPanel } from "@/components/panels/plan-panel";

export default function OutlineStepPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-6 py-6">
			<OutlinePanel projectId={projectId} onSaved={() => undefined} />
			<PlanPanel onSaved={() => undefined} />
		</div>
	);
}
