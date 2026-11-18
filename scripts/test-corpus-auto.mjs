// 本机古籍固定、史料人物候选与确认后自动生成的端到端回归。
// 必须在 HISTORY_DATA_DIR 隔离目录上运行，并且全程只走本地骨架：脚本不发任何真实模型请求。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { cleanupStoryProject } from './lib/story-chain.mjs'

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000'
const dataDir = process.env.HISTORY_DATA_DIR
if (!dataDir) {
	console.error('必须设置 HISTORY_DATA_DIR 指向隔离数据目录，避免把测试作品写进真实工作区。')
	process.exit(1)
}

const database = new Database(path.join(dataDir, 'workspace.sqlite'))
database.pragma('foreign_keys = ON')
let projectId

async function call(route, body, expected = 200, method) {
	const isGet = body === undefined
	const response = await fetch(`${base}${route}`, {
		method: isGet ? 'GET' : method ?? 'POST',
		headers: { origin: base, 'content-type': 'application/json' },
		body: isGet ? undefined : JSON.stringify(body),
	})
	const data = await response.json()
	assert.equal(response.status, expected, `${route} -> ${JSON.stringify(data)}`)
	return data
}

function step(run, key) {
	return run.steps.find((item) => item.key === key)
}

const startYear = 900
const endYear = 910
const region = '中原'

try {
	const project = await call('/api/projects', { name: `本机全集自动生成测试-${Date.now()}` }, 201)
	projectId = project.project.id
	const corpusRoute = `/api/projects/${projectId}/corpus`
	const referencesRoute = `/api/projects/${projectId}/references`
	const personsRoute = `/api/projects/${projectId}/persons`
	const autoRoute = `/api/projects/${projectId}/auto`
	const outlineRoute = `/api/projects/${projectId}/outline`
	const eventsRoute = `/api/projects/${projectId}/events`
	const setupRoute = `/api/projects/${projectId}/setup`

	// 1. 前置条件：本机语料与人物索引已建好，否则给出脚本名而不是静默跳过。新建项目即固定全集。
	const corpus = await call(corpusRoute)
	assert.equal(corpus.ready, true, '请先执行 npm run corpus:index')
	assert.equal(corpus.personsIndexed, true, '请先执行 npm run corpus:persons')
	assert.ok(corpus.personsRows > 0)
	assert.equal(corpus.pinned, true, '新建项目应自动固定本机古籍语料')
	assert.ok(corpus.pinning.books.length > 0, '固定记录应包含书目')

	// 2. 证据必须命中固定原文：伪造出处与原文中不存在的片段都要拒绝。
	await call(setupRoute, { action: 'person', name: '无据人物', start: '901', end: '905', region, documentId: 'missing-document', evidence: '太祖', confirmed: true }, 400)
	const documents = (await call(`/api/projects/${projectId}/documents`)).documents
	const corpusDocument = documents.find((item) => item.corpusRef)
	assert.ok(corpusDocument, '固定语料应作为资料出现在项目资料列表中')
	await call(setupRoute, { action: 'person', name: '无据人物', start: '901', end: '905', region, documentId: corpusDocument.id, evidence: '这句话肯定不在任何古籍原文里', confirmed: true }, 400)

	// 3. 时间阶段决定范围内书目；重复固定保持同一份书目。
	await call(`/api/projects/${projectId}/scope`, { startYear, endYear, region }, 200, 'PUT')
	const repinned = await call(corpusRoute, { action: 'pin' })
	assert.deepEqual(
		repinned.pinning.books.map((book) => book.id).sort(),
		corpus.pinning.books.map((book) => book.id).sort(),
		'重复固定不应改变书目'
	)
	const scoped = await call(corpusRoute)
	const scopeBookIds = new Set(scoped.scopeBooks.map((book) => book.id))
	assert.ok(scopeBookIds.size > 0, '当前时间阶段应有重叠书目')

	const references = await call(referencesRoute)
	assert.ok(references.registered.length > 0, '请先执行 npm run refs:register')
	assert.ok(references.registered.every((series) => series.spec), '已登记系列应带抽象写作规格')
	assert.ok(references.pinned, '新建项目应自动固定默认参考小说')
	// T051：自动固定只把登记规格派生为待确认草稿，确认前作品没有可用规格文本。
	assert.equal(references.pinned.version, null, '新作品的写作规格应先停在草稿，确认后才生效')
	assert.equal(references.pinned.specChars, 0)
	assert.equal(references.pinned.pendingVersion, 1)
	assert.equal(references.specVersions.length, 1)
	assert.equal(references.specVersions[0].confirmedAt, null)
	assert.equal(references.pinned.drift, null, `参考小说已漂移：${references.pinned.drift}`)
	// 确认之后才有规格可注入请求，这里故意留到采用事件之后再确认，便于验证未确认时的生成门禁。

	// 4. 候选与强关联：默认勾选的每个人都必须能在固定原文里命中证据。
	const persons = await call(`${personsRoute}?limit=20`)
	assert.equal(persons.ready, true, '请先执行 npm run corpus:years，人物候选按年份档案筛选')
	assert.ok(persons.defaults.length > 0, '范围内应给出默认候选')
	assert.ok(persons.candidates.length >= persons.defaults.length)
	const evidenceProbe = database.prepare('SELECT COUNT(*) AS count FROM corpus_volume WHERE book_id = ? AND instr(text, ?) > 0')
	for (const name of persons.defaults.slice(0, 5)) {
		const candidate = persons.candidates.find((item) => item.name === name)
		assert.ok(candidate, `${name} 应出现在候选列表中`)
		assert.equal(candidate.strong, true, `${name} 属于默认勾选，应标记为强关联`)
		assert.ok(candidate.evidence.length > 0, `${name} 缺少原文证据片段`)
		assert.ok(scopeBookIds.has(candidate.evidenceBook), `${name} 的证据书目 ${candidate.evidenceBook} 不在固定范围内`)
		assert.equal(evidenceProbe.get(candidate.evidenceBook, candidate.evidence).count > 0, true, `${name} 的证据不是固定原文的子串`)
		// 需求 1：候选只能生活在所选区间内（区间有交集即入选），并带着可核对的生卒与事迹。
		assert.equal(candidate.yearState, 'in-range', `${name} 的年份不该进入确定候选`)
		assert.equal(candidate.profile?.plausible, true, `${name} 的年份档案不可信，不应混入确定候选`)
		const from = candidate.profile?.birth ?? candidate.profile?.activeFrom
		const to = candidate.profile?.death ?? candidate.profile?.activeTo
		assert.ok(from <= endYear && to >= startYear, `${name} 的 ${from}—${to} 与 ${startYear}—${endYear} 没有交集`)
		assert.ok(candidate.profile?.deeds.length > 0, `${name} 应展示主要事迹`)
	}
	assert.ok(persons.pending.every((item) => item.yearState === 'unknown'), '待核组不得混入按年份筛出的候选')
	// 评审修复：年份可信但整体落在区间外的人（如 904—960 项目里的郭子儀）不是「待核」，须整体排除而不是换个标签。
	assert.ok(persons.pending.every((item) => !item.profile || item.profile.plausible !== true), '年份可信却区间外的人物不得进入待核组')

	// 4.1 区域非必填：留空即不限区域，候选仍只按年份区间筛选。
	await call(`/api/projects/${projectId}/scope`, { startYear, endYear, region: '' }, 200, 'PUT')
	const openRegion = await call(`${personsRoute}?limit=20`)
	assert.deepEqual(
		openRegion.candidates.map((item) => item.name),
		persons.candidates.map((item) => item.name),
		'区域留空不应改变按年份筛出的候选'
	)
	await call(`/api/projects/${projectId}/scope`, { startYear, endYear, region }, 200, 'PUT')

	// 4.2 范围外不再给候选：把区间挪到通鉴开始之前，确定候选应为空并提示手工新增。
	const outside = await call(`${eventsRoute}/candidates?start=-900&end=-800`)
	assert.equal(outside.ready, true)
	assert.equal(outside.candidates.length, 0, '早于史料覆盖范围时不应给出事件候选')
	assert.match(outside.note, /请手工新增/)

	// 5. 自动生成前锁定为本地模式，并确认未授权外发。
	const settings = await call(autoRoute, { action: 'settings', outlineMode: 'local', allowExternalTransfer: false })
	assert.equal(settings.settings.outlineMode, 'local')
	assert.equal(settings.settings.allowExternalTransfer, false)

	const firstRun = (await call(autoRoute, { action: 'generate', startYear, endYear, region, plannedChapters: 6 })).run
	// T050：自动流程只准备派生事件候选，采用必须由作者核对原文，首轮因此停在计划步骤。
	assert.equal(firstRun.status, 'failed', JSON.stringify(firstRun.steps))
	assert.ok(step(firstRun, 'characters').detail.includes('导入'))
	assert.equal(firstRun.events.adopted, 0, '派生事件不得自动采用')
	assert.ok(firstRun.events.candidates > 0, '应准备好待人工核对的派生事件候选')
	assert.equal(step(firstRun, 'plan').ok, false, '没有已采用证据时不应生成大纲')

	const candidates = (await call(eventsRoute)).candidates
	assert.ok(candidates.length > 0, '事件面板应列出待核对候选')
	// 未勾选核对原文的采用必须被拒绝。
	await call(eventsRoute, { action: 'adopt', sourceKey: candidates[0].sourceKey, confirmed: false }, 400)
	assert.ok(candidates.length >= 6, `候选不足以铺满 6 章骨架：${candidates.length}`)
	for (const candidate of candidates.slice(0, 8)) {
		await call(eventsRoute, { action: 'adopt', sourceKey: candidate.sourceKey, confirmed: true })
	}

	// 5.1 已有采用证据但规格仍是草稿：大纲被门禁拦下，确认版本后才进入下一道门禁（REQ-010）。
	assert.match((await call(outlineRoute)).blocked, /写作规格尚未确认/, '未确认规格版本应阻断大纲生成')
	await call(referencesRoute, { action: 'confirmSpec', version: 1 })
	// T052：规格确认后仍要先选定剧情提案，章纲才解锁；自动流程也停在提案步骤。
	assert.match((await call(outlineRoute)).blocked, /剧情提案/, '未选定提案时不应放行章纲')
	assert.match((await call(autoRoute, { action: 'generate', startYear, endYear, region, plannedChapters: 6 })).run.steps.find((item) => item.key === 'plan').detail, /剧情提案/)
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM story_plans WHERE project_id = ?').get(projectId).count, 0, '未选定提案不得写入规划')
	const proposalRoute = `/api/projects/${projectId}/proposals`
	const localProposals = await call(proposalRoute, { action: 'local' })
	assert.equal(localProposals.proposals.length, 3)
	assert.ok(localProposals.proposals.every((item) => item.source === 'local' && item.evidence.length > 0))
	await call(proposalRoute, { action: 'select', slot: 1 })
	assert.equal((await call(outlineRoute)).blocked, null, '选定提案后章纲前置条件应满足')

	// 6. 核对采用后重跑：本地骨架大纲基于已核对证据生成，且不调用模型。
	const secondRun = (await call(autoRoute, { action: 'generate', startYear, endYear, region, plannedChapters: 6 })).run
	assert.equal(secondRun.status, 'ok', JSON.stringify(secondRun.steps))
	assert.equal(secondRun.events.adopted, 0, '已采用的事件不应再次采用')
	assert.ok(secondRun.plan.chapters > 0)
	const outlineStep = step(secondRun, 'outline')
	assert.ok(outlineStep.ok)
	assert.ok(outlineStep.detail.includes('不调用模型'), '本地模式不应触发模型调用')
	assert.equal(secondRun.outline.attempted, false)
	assert.equal(secondRun.outline.requestId, null)

	// 6. 骨架大纲：来源标注、结构、证据编号全部真实存在。
	const planRow = database.prepare('SELECT version, plan_json FROM story_plans WHERE project_id = ?').get(projectId)
	assert.ok(planRow, '自动生成应写入规划版本')
	const plan = JSON.parse(planRow.plan_json)
	assert.equal(plan.origin, 'local')
	assert.equal(plan.proposal?.slot, 1, '本地骨架应绑定选定提案')
	assert.ok(plan.proposal?.inputHash)
	assert.ok(plan.title.includes('本地骨架大纲'))
	assert.equal(plan.chapters.length, 6)
	const outlineState = await call(outlineRoute)
	const evidenceIds = new Set(outlineState.evidence.map((item) => item.id))
	assert.ok(evidenceIds.size > 0)
	for (const chapter of plan.chapters) {
		assert.ok(chapter.plot.length > 0, `${chapter.id} 不应为空章节`)
		assert.ok(chapter.historyEvidence.length > 0, `${chapter.id} 缺少证据引用`)
		for (const id of chapter.historyEvidence) assert.equal(evidenceIds.has(id), true, `引用了不存在的证据编号 ${id}`)
	}
	const planBadge = outlineState.plan
	assert.equal(planBadge.origin, 'local')
	assert.equal(planBadge.version, planRow.version)
	assert.equal(outlineState.reference.series, references.pinned.series)

	// 7. 参考小说隔离：生成上下文只带抽象规格，预览提示词与落库规划都不含卷级原文。
	const preview = await call(outlineRoute, { plannedChapters: 6 })
	assert.equal(preview.dryRun, true)
	const specText = plan.generationContext?.reference?.writingSpecification ?? ''
	assert.ok(specText.length > 0, '生成上下文应带参考小说的抽象写作规格')
	// T051：大纲请求带作品已确认规格版本的全文抽象规格与抽象方法，且与规划快照记录的是同一份规格。
	const outlineRequest = preview.prompt.user
	assert.ok(outlineRequest.writingSpecification.length > 0, '大纲请求应带已确认规格全文')
	assert.equal(outlineRequest.writingSpecification, specText, '大纲请求的规格全文应与快照一致')
	assert.deepEqual(outlineRequest.writingMethods, plan.generationContext.reference.originalWritingSpecification, '大纲请求的抽象方法应来自同一版本')
	assert.equal(outlineRequest.writingSpecVersion, 1, '大纲请求应记录规格版本')
	assert.equal(plan.generationContext.reference.specVersion, 1, '规划快照应记录所用规格版本')
	assert.equal(createHash('sha256').update(specText, 'utf8').digest('hex'), plan.generationContext.reference.specSha256)
	const searchedJson = [JSON.stringify(preview.prompt), planRow.plan_json].join('\n')
	const volumes = database.prepare('SELECT volume, text_path FROM reference_novel').all()
	assert.ok(volumes.length > 0)
	for (const volume of volumes) {
		const text = await readFile(path.join(process.cwd(), volume.text_path), 'utf8')
		// 逐块扫描：只抽两处偏移会漏掉恰好出现在别处的原文片段，规格文本与提示词都不该命中。
		for (let offset = 0; offset + 40 <= text.length; offset += 4096) {
			const sample = text.slice(offset, offset + 40)
			assert.equal(searchedJson.includes(sample), false, `${volume.volume} 的原文片段出现在大纲提示词或规划中`)
		}
	}

	// 8. 幂等重跑：四步仍为成功，且不新增规划版本（否则会撤销既有人工确认）。
	const rerun = (await call(autoRoute, { action: 'generate', startYear, endYear, region, plannedChapters: 6 })).run
	assert.equal(rerun.status, 'ok', JSON.stringify(rerun.steps))
	assert.equal(rerun.characters.imported.length, 0)
	assert.ok(step(rerun, 'characters').detail.includes('已在项目内'))
	assert.ok(step(rerun, 'relations').detail.includes('已存在') || step(rerun, 'relations').detail.includes('新增 0'), step(rerun, 'relations').detail)
	assert.ok(step(rerun, 'events').detail.includes('候选'), step(rerun, 'events').detail)
	assert.ok(step(rerun, 'plan').detail.includes('一致，未新增版本'), step(rerun, 'plan').detail)
	const rerunPlanRow = database.prepare('SELECT version FROM story_plans WHERE project_id = ?').get(projectId)
	assert.equal(rerunPlanRow.version, planRow.version, '幂等重跑不得递增规划版本')
	assert.equal(rerun.outline.attempted, false)

	// 9. 作品写作规格版本（T051）：编辑只产生草稿，确认才生效；确认更新版本后旧方案提示复核但不阻断。
	const storyRoute = `/api/projects/${projectId}/story`
	assert.equal((await call(storyRoute)).specNotice, null, '方案按当时已确认规格生成时不应提示漂移')
	await call(referencesRoute, { action: 'saveSpec', specText: `${specText}

本章改用单一视角，并把悬念收在结尾。` })
	const drafted = (await call(referencesRoute)).pinned
	assert.equal(drafted.version, 1, '草稿不应改变正在生效的规格版本')
	assert.equal(drafted.pendingVersion, 2, '草稿应作为待确认版本列出')
	assert.equal((await call(storyRoute)).specNotice, null, '未确认的草稿不应影响既有方案')
	assert.equal((await call(outlineRoute)).blocked, null, '草稿状态下大纲前置条件仍应满足')
	await call(referencesRoute, { action: 'confirmSpec', version: 2 })
	assert.equal((await call(referencesRoute)).pinned.version, 2)
	const driftedStory = await call(storyRoute)
	assert.ok(driftedStory.specNotice?.includes('v1'), `方案应提示规格已更新：${driftedStory.specNotice}`)
	assert.equal(driftedStory.evidenceIssues.length, 0, '规格漂移不应被当成证据问题')
	assert.equal((await call(outlineRoute)).blocked, null, '规格漂移只提示复核，不阻断生成')

	console.log('PASS: corpus pinning, evidence guards, strong-relation candidates, local skeleton outline, spec version confirm/draft/drift, reference isolation, idempotent rerun; no model requests.')
} finally {
	if (projectId) {
		cleanupStoryProject(database, projectId)
	}
	database.close()
}
