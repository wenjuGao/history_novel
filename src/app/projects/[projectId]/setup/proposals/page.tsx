"use client";

import { useParams } from "next/navigation";
import { ProposalPanel } from "@/components/panels/proposal-panel";

export default function ProposalsStepPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<ProposalPanel projectId={projectId} onSaved={() => undefined} />
		</div>
	);
}
