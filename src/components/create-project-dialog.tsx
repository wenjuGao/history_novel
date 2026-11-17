"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ProjectSummary = {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	version: number;
};

export function CreateProjectDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (project: ProjectSummary) => void;
}) {
	const [name, setName] = useState("");
	const [failed, setFailed] = useState("");
	const [saving, setSaving] = useState(false);

	async function submit() {
		setFailed("");
		setSaving(true);
		try {
			const response = await fetch("/api/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
			const result = (await response.json()) as { project?: ProjectSummary; error?: string };
			if (!response.ok || !result.project) throw new Error(result.error ?? "无法创建作品。");
			onCreated(result.project);
			setName("");
			onOpenChange(false);
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : "无法创建作品。");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>创建作品</DialogTitle>
					<DialogDescription>历史范围可在创建后设置。</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					<Label htmlFor="project-name">作品名称</Label>
					<Input
						id="project-name"
						autoFocus
						maxLength={80}
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="例如：长安旧事"
						aria-invalid={Boolean(failed)}
					/>
					<p className="text-[11px] text-muted-foreground">1 至 80 个字符，仅保存在本机。</p>
					{failed && <p className="text-[11px] text-destructive" role="alert">{failed}</p>}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button disabled={saving || name.trim().length === 0} onClick={() => void submit()}>
						{saving ? "保存中…" : "创建并保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
