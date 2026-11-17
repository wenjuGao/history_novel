import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { cleanupStoryProject, seedStoryPlan } from './lib/story-chain.mjs'

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000'
const database = new Database(path.join(process.env.HISTORY_DATA_DIR ?? 'data/local', 'workspace.sqlite'))
database.pragma('foreign_keys = ON')
let projectId

async function call(route, body, expected = 200) {
	const response = await fetch(`${base}${route}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { origin: base, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	})
	const data = await response.json()
	assert.equal(response.status, expected, JSON.stringify(data))
	return data
}

try {
	// T052：章纲不再由静态试跑资料初始化，这里走完整本地链路（采用证据→选定提案→本地骨架章纲）。
	const seeded = await seedStoryPlan(base, { name: `计费门禁测试-${Date.now()}` })
	projectId = seeded.projectId
	const route = seeded.routes.story
	let state = seeded.state
	const tokenPlan = state.estimate.billingMode === 'token-plan'
	const request = { version: state.version, planHash: state.planHash }
	// REQ-035：确认方案不再要求整书预算——只固定「当前方案哈希 + 证据核对 + 资料外发 + 模型与计费口径」。
	const approve = { ...request, action: 'approve', evidenceConfirmed: true, allowExternalTransfer: true }
	await call(route, { ...request, action: 'generate', chapterId: state.plan.chapters[0].id }, 409)
	await call(route, { ...approve, evidenceConfirmed: false }, 400)
	await call(route, { ...approve, allowExternalTransfer: false }, 400)
	await call(route, { ...approve, planHash: 'stale' }, 409)
	// 旧口径的预算数字仍可提交，只作为当时估算的备注保存。
	const noted = await call(route, { ...approve, tokenBudget: state.estimate.totalTokens, budgetCny: (state.estimate.totalCny ?? 0) + 1 })
	assert.equal(noted.billingMode, state.estimate.billingMode)
	const withBudget = await call(route)
	assert.equal(withBudget.approval.modelId, state.estimate.modelId)
	assert.equal(withBudget.approval.billingMode, state.estimate.billingMode)
	assert.equal(withBudget.approval.allowExternalTransfer, 1)
	assert.equal(withBudget.approval.evidenceConfirmed, 1)
	assert.equal(withBudget.approval.tokenBudget, tokenPlan ? state.estimate.totalTokens : null)
	assert.equal(withBudget.approval.budgetCny, tokenPlan ? null : (state.estimate.totalCny ?? 0) + 1)
	if (tokenPlan) {
		assert.equal(withBudget.estimate.totalCny, null)
		assert(withBudget.estimate.chapters.every((chapter) => chapter.ceilingCny === null))
	}
	// 不填预算同样可以确认；重新确认会把备注清空，而不是保留旧额度。
	const bare = await call(route, approve)
	assert.equal(bare.tokenBudget, null)
	assert.equal(bare.budgetCny, null)
	const withoutBudget = await call(route)
	assert.equal(withoutBudget.approval.tokenBudget, null)
	assert.equal(withoutBudget.approval.budgetCny, null)
	assert.equal(withoutBudget.approval.planHash, state.planHash)

	// 逐章顺序门禁与请求前的口径复核仍然生效：以下每种漂移都必须在发出请求前被拒。
	await call(route, { ...request, action: 'generate', chapterId: state.plan.chapters[1].id }, 409)
	database.prepare('UPDATE story_plan_approvals SET model_id=? WHERE project_id=?').run('changed-model', projectId)
	await call(route, { ...request, action: 'generate', chapterId: state.plan.chapters[0].id }, 409)
	database
		.prepare('UPDATE story_plan_approvals SET model_id=?, billing_mode=? WHERE project_id=?')
		.run(state.estimate.modelId, tokenPlan ? 'pay-as-you-go' : 'token-plan', projectId)
	await call(route, { ...request, action: 'generate', chapterId: state.plan.chapters[0].id }, 409)
	// REQ-035：额度数字（哪怕是 0）不再参与单章门禁；外发同意与方案哈希仍然必须匹配。
	database
		.prepare('UPDATE story_plan_approvals SET billing_mode=?, token_budget=0, budget_cny=0, allow_external_transfer=0 WHERE project_id=?')
		.run(state.estimate.billingMode, projectId)
	await call(route, { ...request, action: 'generate', chapterId: state.plan.chapters[0].id }, 409)
	database.prepare('UPDATE story_plan_approvals SET allow_external_transfer=1 WHERE project_id=?').run(projectId)
	await call(route, { ...request, planHash: 'f'.repeat(64), action: 'generate', chapterId: state.plan.chapters[0].id }, 409)
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM chapter_generation_attempts WHERE project_id=?').get(projectId).count, 0)
	console.log(
		`PASS: ${state.estimate.billingMode} approval without whole-book budget, persisted notes, stale version, model/mode changes, chapter ordering; no model requests.`
	)
} finally {
	if (projectId) cleanupStoryProject(database, projectId)
	database.close()
}
