"use client";

import { useEffect, useState } from "react";
import { Check, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useStory } from "@/components/story-provider";

export function PlanPanel({ onSaved }: { onSaved?: () => void }) {
	const story = useStory();
	const { data, plan, status, dirty, busy } = story;
	const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
	const [externalTransfer, setExternalTransfer] = useState(false);

	useEffect(() => {
		if (!data) return;
		setEvidenceConfirmed(data.approval?.evidenceConfirmed === 1);
		setExternalTransfer(data.approval?.allowExternalTransfer === 1);
	}, [data]);

	if (status === "loading") {
		return (
			<div className="flex flex-col gap-2" role="status" aria-label="正在读取故事方案">
				<Skeleton className="h-8" />
				<Skeleton className="h-24" />
				<Skeleton className="h-16" />
			</div>
		);
	}

	if (status === "failed") {
		return <Alert variant="destructive"><AlertDescription>{story.error}</AlertDescription></Alert>;
	}

	if (!plan || !data?.planHash || !data.estimate) {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-[12px] leading-relaxed text-muted-foreground">
					这部作品还没有可用的章节目录。章纲只能由本作品自己的范围、已采用史实与选定剧情提案产生：先在「剧情提案」步骤选定一份，再到「章纲」步骤生成本地骨架或模型大纲。
				</p>
				{data?.blocked && (
					<Alert variant="destructive">
						<AlertDescription>{data.blocked}</AlertDescription>
					</Alert>
				)}
				{story.error && <Alert variant="destructive"><AlertDescription>{story.error}</AlertDescription></Alert>}
			</div>
		);
	}

	const estimate = data.estimate;
	const tokenPlan = story.tokenPlan;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-[12px] leading-relaxed text-muted-foreground">
				先定全书骨架与逐章情节，保存为新版本后人工确认；确认后右侧才可按章生成正文。
			</p>

			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="plan-title">作品标题</Label>
					<Input
						id="plan-title"
						maxLength={120}
						value={plan.title}
						onChange={(event) => story.updatePlan((current) => ({ ...current, title: event.target.value }))}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="plan-synopsis">全书梗概</Label>
					<Textarea
						id="plan-synopsis"
						rows={5}
						maxLength={10000}
						value={plan.synopsis}
						onChange={(event) => story.updatePlan((current) => ({ ...current, synopsis: event.target.value }))}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="plan-question">核心问题</Label>
					<Textarea
						id="plan-question"
						rows={2}
						maxLength={2000}
						value={plan.centralQuestion}
						onChange={(event) => story.updatePlan((current) => ({ ...current, centralQuestion: event.target.value }))}
					/>
				</div>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					范围：{plan.scope.period} · {plan.scope.regions.join("、")}
				</p>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					共 {plan.chapters.length} 章。章节目录与每章情节在右侧产物栏编辑；本页只定全书骨架与确认口径。
				</p>
			</div>

			{plan.generationContext?.reference && (
				<details className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2">
					<summary className="cursor-pointer text-[12px] font-medium text-foreground">
						写作规格 · {plan.generationContext.reference.title}
						{plan.generationContext.reference.specVersion ? ` · 已确认 v${plan.generationContext.reference.specVersion}` : " · 未记录版本"}
					</summary>
					<p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
						{plan.generationContext.reference.coverage}
					</p>
					<pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
						{plan.generationContext.reference.writingSpecification}
					</pre>
				</details>
			)}

			<Separator />

			<div className="flex flex-col gap-3">
				<h4 className="text-[13px] font-medium text-foreground">人工确认</h4>
				{data.proposalIssue && (
					<Alert variant="destructive">
						<AlertDescription>{data.proposalIssue}</AlertDescription>
					</Alert>
				)}
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					方案第 {data.version} 版 · {plan.origin === "local" ? "本地骨架大纲" : plan.origin === "model" ? "模型大纲" : "人工编辑大纲"} · 哈希 {data.planHash.slice(0, 12)}… · {plan.chapters.length} 章 ·{" "}
					{tokenPlan
						? `Token Plan，整书工作量估算 ${estimate.totalTokens.toLocaleString()} Token`
						: `按量计费，整书费用估算 ¥${(estimate.totalCny ?? 0).toFixed(3)}`}
					。估算只用于了解规模，不再作为确认或生成的门槛。
				</p>

				<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/60 px-3 py-2">
					<h5 className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">本方案引用的史料</h5>
					{data.evidence.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">方案尚未绑定史料编号。</p>
					) : (
						<ul className="flex flex-col gap-1">
							{data.evidence.map((item) => (
								<li className="text-[11px] leading-relaxed text-muted-foreground" key={item.evidenceId}>
									<strong className="text-foreground">{item.evidenceId}</strong> · {item.title} · {item.status}
									{item.revisionUrl ? (
										<>
											{" "}·{" "}
											<a className="underline underline-offset-2" href={item.revisionUrl} target="_blank" rel="noreferrer">
												原文
											</a>
										</>
									) : null}
								</li>
							))}
						</ul>
					)}
				</div>

				<label className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
					<Checkbox className="mt-0.5" checked={evidenceConfirmed} onCheckedChange={(value) => setEvidenceConfirmed(value === true)} />
					<span>我已核对故事梗概、章节情节及上述固定版本原文</span>
				</label>
				<label className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
					<Checkbox className="mt-0.5" checked={externalTransfer} onCheckedChange={(value) => setExternalTransfer(value === true)} />
					<span>我同意将当前章节所需内容发送到百炼生成服务</span>
				</label>

				{/* REQ-035：正文入口不再要求整书预算；确认只固定方案、外发与证据口径，每次请求各自记录估算与真实用量。 */}
				<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/60 px-3 py-2">
					<h5 className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">用量记录</h5>
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						本方案已累计{" "}
						{tokenPlan
							? `${(data.usage?.spentTokens ?? 0).toLocaleString()} Token`
							: `¥${(data.usage?.spentCny ?? 0).toFixed(3)}`}
						（含失败与未知请求的预留），逐章逐次请求的估算与返回值都保存在本地。
					</p>
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						{tokenPlan
							? "Token Plan 不折算人民币或 Credits；套餐额度以百炼控制台为准，配额不足时请求会停止，不会改用按量服务。"
							: "按量价格取官方标价快照，估算不等于供应商账单。"}
					</p>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{dirty && (
						<Button variant="outline" size="sm" disabled={busy || story.hasRunningChapter} onClick={() => void story.savePlan().then(onSaved)}>
							<Save size={15} /> 保存新版本
						</Button>
					)}
					<Button
						size="sm"
						disabled={busy || dirty || !!data.proposalIssue || !evidenceConfirmed || !externalTransfer}
						onClick={() => void story.approvePlan({ allowExternalTransfer: externalTransfer, evidenceConfirmed }).then(onSaved)}
					>
						<Check size={15} />
						{story.approvalMatches ? "重新确认当前方案" : "确认方案与资料外发"}
					</Button>
				</div>

				{dirty && <p role="status" className="text-[11px] text-warning">方案有未保存的修改，保存后旧确认失效。</p>}
				{story.approvalMatches && !dirty && (
					<p role="status" className="text-[11px] leading-relaxed text-success">
						当前方案已确认，右侧可逐章生成；每次请求仍会先复核方案哈希、证据与写作规格版本。
					</p>
				)}
			</div>

			{story.message && <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{story.message}</p>}
			{story.error && (
				<Alert variant="destructive"><AlertDescription>{story.error}</AlertDescription></Alert>
			)}
		</div>
	);
}
