"use client";

import { useParams } from "next/navigation";
import { DocumentImport } from "@/components/document-import";

export default function ReferencesStepPage() {
	const { projectId } = useParams<{ projectId: string }>();

	return (
		<div className="mx-auto w-full max-w-[52rem] px-6 py-6">
			<DocumentImport projectId={projectId} onImported={() => undefined} />
		</div>
	);
}
