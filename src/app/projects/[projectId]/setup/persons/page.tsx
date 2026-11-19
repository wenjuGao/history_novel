"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { CharacterPicker } from "@/components/character-picker";
import { PersonProfilePanel } from "@/components/panels/person-profile-panel";

export default function PersonsStepPage() {
	const { projectId } = useParams<{ projectId: string }>();
	const [refreshKey, setRefreshKey] = useState(0);

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<PersonProfilePanel projectId={projectId} onChanged={() => setRefreshKey((current) => current + 1)} />
			<details className="mt-6 rounded-sm border border-border px-3 py-2.5">
				<summary className="cursor-pointer text-[12px] text-muted-foreground">
					史料人物候选、关系线索与虚构设定（不在本事件线上时再展开）
				</summary>
				<div className="pt-3">
					<CharacterPicker projectId={projectId} refresh={refreshKey} onChanged={() => setRefreshKey((current) => current + 1)} />
				</div>
			</details>
		</div>
	);
}
