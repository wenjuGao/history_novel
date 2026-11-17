"use client";

import { useParams } from "next/navigation";
import { EventPanel } from "@/components/panels/event-panel";

export default function EventsStepPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<EventPanel projectId={projectId} onChanged={() => undefined} />
		</div>
	);
}
