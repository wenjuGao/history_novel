"use client";

import { useParams } from "next/navigation";
import { ScopePanel } from "@/components/panels/scope-panel";

export default function ScopeStepPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<ScopePanel projectId={projectId} onSaved={() => undefined} />
		</div>
	);
}
