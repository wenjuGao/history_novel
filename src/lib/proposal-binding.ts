import 'server-only'

import { db } from '@/lib/db'
import { buildGenerationContext } from '@/lib/plot-events'
import { sha256, type ProposalBinding, type StoryPlan } from '@/lib/story-plan'

// 剧情提案与章纲之间的绑定关系（REQ-051、REQ-056）：
// 提案记录它当时依据的输入版本哈希，章纲记录它当时选定的提案槽位、修订号与同一份哈希。
// 范围、人物、关系、虚构设定或已采用史实任一变化，就说明提案赖以成立的输入已经不同，必须回到提案步骤重来；
// 写作规格版本的变化只作为复核提示，不作废选定（见 `proposalInputHash`）。

export type { ProposalBinding }

export function proposalInputHash(projectId: string): string | null {
	const context = buildGenerationContext(projectId)
	if (!context) return null
	// 写作规格版本不进哈希：确认新规格版本只让既有方案提示复核（REQ-053 旧稿保留原版本），
	// 不应把已选定的提案与章纲一并作废；规格版本记录在提案与方案快照里供界面核对。
	const canonical = JSON.stringify({
		scope: context.scope,
		characters: context.historicalCharacters,
		relations: context.associationPreview,
		fiction: context.fiction,
		evidence: context.evidence.map((item) => ({ id: item.id, sourceEventId: item.sourceEventId ?? null, text: item.text })),
	})
	return sha256(canonical)
}

export function selectedProposalBinding(projectId: string): ProposalBinding | null {
	const row = db
		.prepare('SELECT slot, revision, input_hash, title FROM plot_proposals WHERE project_id = ? AND status = \'selected\' ORDER BY slot LIMIT 1')
		.get(projectId) as { slot: number; revision: number; input_hash: string; title: string } | undefined
	if (!row) return null
	return { slot: row.slot, revision: row.revision, inputHash: row.input_hash, title: row.title }
}

// 章纲生成前的门禁：必须有一份当前仍然成立的选定提案。
export function proposalGateReason(projectId: string): string | null {
	const binding = selectedProposalBinding(projectId)
	if (!binding) return '请先在「剧情提案」步骤生成并选定一份提案，章纲需要绑定选定提案。'
	const input = proposalInputHash(projectId)
	if (!input) return '请先完成范围、史料人物与已采用事件配置，再重新选定剧情提案。'
	if (binding.inputHash !== input) return '选定提案所依据的范围、人物关系或已采用史实已变化，请回到「剧情提案」步骤重新生成或重新选定。'
	return null
}

// 方案确认与逐章生成前的复核：章纲里记录的提案绑定必须仍然有效。
export function planProposalIssue(projectId: string, plan: { proposal?: ProposalBinding | null }): string | null {
	if (!plan.proposal) return '本章纲未绑定剧情提案，请重新保存或重新生成章纲后再确认方案。'
	const gate = proposalGateReason(projectId)
	if (gate) return gate
	const binding = selectedProposalBinding(projectId)!
	if (plan.proposal.slot !== binding.slot || plan.proposal.revision !== binding.revision) {
		return `本章纲绑定的是提案第 ${plan.proposal.slot} 项第 ${plan.proposal.revision} 版，当前选定的是第 ${binding.slot} 项第 ${binding.revision} 版；请重新生成章纲并复核章节。`
	}
	return null
}

// 每一处产生章纲的路径（模型大纲、本地骨架、人工保存）都在写库前盖上当时选定的提案，
// 哈希比较与幂等判断因此包含提案绑定，不会在重跑时产生无谓的新版本。
export function stampProposal(projectId: string, plan: StoryPlan): StoryPlan {
	return { ...plan, proposal: selectedProposalBinding(projectId) }
}
