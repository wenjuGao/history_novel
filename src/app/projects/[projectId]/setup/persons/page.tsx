"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { CharacterPicker } from "@/components/character-picker";

export default function PersonsStepPage() {
	const { projectId } = useParams<{ projectId: string }>();
	const [refreshKey, setRefreshKey] = useState(0);

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<CharacterPicker
				projectId={projectId}
				refresh={refreshKey}
				onChanged={() => setRefreshKey((current) => current + 1)}
			/>
		</div>
	);
}
