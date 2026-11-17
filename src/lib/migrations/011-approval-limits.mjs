// 011 迁移（一次性，PRAGMA user_version 守护）：正文入口不再要求整书预算（REQ-035）。
// story_plan_approvals.budget_cny 原本 NOT NULL CHECK(budget_cny > 0)，套餐模式下还被迫写占位值；
// 这里重建为两列皆可空——审批只固定「方案哈希 + 外发同意 + 证据核对 + 模型与计费模式」，
// 预算不再由用户填写，历史行保留当时的数值（套餐模式的占位值清成 NULL），用量记录仍逐请求落库。

export const APPROVAL_LIMITS_VERSION = 11

const expectedColumns = [
	'project_id',
	'plan_version',
	'plan_hash',
	'budget_cny',
	'token_budget',
	'billing_mode',
	'model_id',
	'allow_external_transfer',
	'evidence_confirmed',
	'approved_at',
]

export function applyApprovalLimitsMigration(database) {
	const current = database.pragma('user_version', { simple: true })
	if (current >= APPROVAL_LIMITS_VERSION) return

	// 重建基于硬编码列集：新增列若没同步到这里就会被静默丢弃，宁可先失败也不丢数据。
	const actual = database.pragma('table_info(story_plan_approvals)').map((column) => column.name)
	const unexpected = actual.filter((name) => !expectedColumns.includes(name))
	if (unexpected.length) {
		throw new Error(`story_plan_approvals 存在 011 未知的列（${unexpected.join('、')}）；请先扩展 011 迁移的重建语句再升级。`)
	}
	const missing = expectedColumns.filter((name) => !actual.includes(name))
	if (missing.length) {
		throw new Error(`story_plan_approvals 缺少 011 预期的列（${missing.join('、')}）；请先执行 applyAddedColumns。`)
	}

	const rebuild = database.transaction(() => {
		database.exec(`
			CREATE TABLE story_plan_approvals_v2 (
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				plan_version INTEGER NOT NULL,
				plan_hash TEXT NOT NULL,
				budget_cny REAL,
				token_budget INTEGER,
				billing_mode TEXT NOT NULL DEFAULT 'pay-as-you-go',
				model_id TEXT NOT NULL DEFAULT 'qwen3.8-max',
				allow_external_transfer INTEGER NOT NULL CHECK(allow_external_transfer IN (0, 1)),
				evidence_confirmed INTEGER NOT NULL DEFAULT 0,
				approved_at TEXT NOT NULL,
				PRIMARY KEY(project_id, plan_version)
			);
			INSERT INTO story_plan_approvals_v2 (project_id, plan_version, plan_hash, budget_cny, token_budget, billing_mode, model_id, allow_external_transfer, evidence_confirmed, approved_at)
				SELECT project_id, plan_version, plan_hash,
					CASE WHEN billing_mode = 'token-plan' THEN NULL ELSE budget_cny END,
					token_budget, billing_mode, model_id, allow_external_transfer, evidence_confirmed, approved_at
				FROM story_plan_approvals;
			DROP TABLE story_plan_approvals;
			ALTER TABLE story_plan_approvals_v2 RENAME TO story_plan_approvals;
		`)
		database.pragma(`user_version = ${APPROVAL_LIMITS_VERSION}`)
	})
	rebuild()
}
