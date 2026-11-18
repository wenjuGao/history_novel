import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { cleanupStoryProject } from './lib/story-chain.mjs'

// T054 创作链回归（SC-002、SC-004、SC-005、SC-009、SC-012、SC-013）。
// 场景 A：单年范围 + 本机古籍 + 参考小说规格，一路走到连续两章与第三章，覆盖门禁、证据出处、状态承接、深链、跨作品隔离与截断/断线恢复。
// 场景 B：含旧派生事件与自动共现关系的作品，核对出处与年代、重新确认受影响方案后才允许继续生成下一章，旧稿版本仍可回看。
// 全程假模型流：拦截器只放行本机回环地址，其余主机一律断言失败；不读取真实 Key，不产生计费调用。
// 必须设置 HISTORY_DATA_DIR 指向已登记古籍与参考小说的隔离副本，否则规格与「年份外古籍」断言走不到真实分支。
// 与其他回归脚本共用 .next-test 构建目录，因此用锁文件避免并发互踩。

const chronicled = '元年，太祖以汴州为开国之地，会群臣于内殿。四年，朱全忠自汴州入朝，李克用屯于洛阳。'
// 场景 B 换一组人物与原文，避免与场景 A 同名导致「只带本作品人物」的断言失去区分力。
const chronicledOther = '四年，朱友恭、氏叔琮同入内殿，议于左次。'
// 每种模式产出互不相同的文本，便于断言「哪一段正文来自哪一次请求」。
const truncatedText = '（截断片段甲）'.repeat(30)
const finishTruncatedText = '（截断后续写收尾乙）'.repeat(20)
const droppedText = '（断线前半丙）'.repeat(30)
const finishDroppedText = '（断线后人工补全丁）'.repeat(20)
const wholeText = '一次成稿的整章正文。'.repeat(30)
const stateSummary = '本章收束后的既定事实。'
const metaSuffix = `\n\n[[META]]${JSON.stringify({
	storyState: { summary: stateSummary, locations: ['朱全忠在汴州'], relations: [], knowledge: [], threads: ['未收束的悬念。'] },
})}`

if (process.env.CREATION_CHAIN_FIXTURE === '1') {
	// 三个路径都由父进程传入：少一个就立刻失败，不能让请求日志静默写进仓库当前目录。
	const requestLog = process.env.CREATION_CHAIN_REQUEST_LOG
	const scriptsFile = process.env.CREATION_CHAIN_SCRIPTS
	const readyFile = process.env.CREATION_CHAIN_READY
	if (!requestLog || !scriptsFile || !readyFile) throw new Error('假模型子进程缺少 CREATION_CHAIN_REQUEST_LOG / SCRIPTS / READY 环境变量')
	const rounds = new Map()
	// 装载即留痕：父进程据此确认拦截器真的装进了服务进程，零请求断言才不会空过。
	writeFileSync(readyFile, 'ready\n')
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
		// 应用自身的本机请求放行，其余主机只能是被编排的模型端点。
		if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, options)
		assert.equal(url.hostname, 'token-plan.cn-beijing.maas.aliyuncs.com', '回归脚本不得访问编排之外的外网主机')
		assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-only', '假模型流不接受真实凭证')
		const body = JSON.parse(options.body)
		const messages = Array.isArray(body.messages) ? body.messages : []
		const userMessage = messages.find((item) => item?.role === 'user')
		assert.ok(userMessage, '模型请求应带上 JSON 化的用户消息')
		const payload = JSON.parse(userMessage.content)
		appendFileSync(requestLog, `${JSON.stringify(payload)}\n`)
		const { mode, key, round } = scriptFor(payload)
		// 剧情提案走非流式结构化输出，正文与章纲才是 SSE，两条分支各自校验。
		if (body.stream !== true) {
			assert.equal(mode, 'proposals', `${key} 编排的是 ${mode}，但请求不是流式`)
			assert.equal(body.response_format?.type, 'json_object', '非流式请求只应是剧情提案的结构化输出')
			const evidenceIds = (payload.evidence ?? []).map((item) => item.id)
			assert.ok(evidenceIds.length, '剧情提案请求应带上证据编号')
			const proposals = Array.from({ length: 3 }, (_, index) => ({
				title: `假提案${index + 1}：内殿的选择`,
				viewpoint: `假提案${index + 1}的叙事视角`,
				mainLine: `假提案${index + 1}的主线：从汴州军议到内殿对质。`,
				synopsis: `假提案${index + 1}的内容梗概。`,
				conflicts: [`假提案${index + 1}的主要冲突`],
				fiction: [`假提案${index + 1}的虚构边界`],
				evidence: [evidenceIds[index % evidenceIds.length]],
			}))
			const completion = {
				id: `chain-outline-${key}-${round}`,
				object: 'chat.completion',
				choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ proposals }) }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100 },
			}
			return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } })
		}
		assert.equal(body.stream, true, '正文请求必须是流式')
		assert.equal(body.enable_thinking, false, '正文请求应关闭思考模式')
		// 续写请求只输出新增段落：已保存正文由服务端自己接在前面。
		const base = payload.continuation?.savedText ?? ''
		if (mode.startsWith('finish')) assert.ok(base.trim(), `${key} 的收尾请求应携带已保存正文作为前缀`)
		let added
		switch (mode) {
			case 'truncate':
				added = truncatedText
				break
			case 'finish-truncated':
				added = finishTruncatedText + metaSuffix
				break
			case 'drop':
				added = droppedText
				break
			case 'finish-dropped':
				added = finishDroppedText + metaSuffix
				break
			case 'plain':
				added = wholeText + metaSuffix
				break
			default:
				assert.fail(`${key} 的编排模式「${mode}」不属于已知模式`)
		}
		assert.ok(added.trim(), `${key} 的 ${mode} 模式没有产出文本`)
		const id = `chain-${key}-${round}`
		const frames = [{ id, choices: [{ index: 0, delta: { content: added }, finish_reason: null }] }]
		// 断线模拟：检查点文本已交付，收尾帧之前让流失败。
		if (mode !== 'drop') frames.push({ id, choices: [{ index: 0, delta: {}, finish_reason: mode === 'truncate' ? 'length' : 'stop' }] })
		frames.push({ id, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } })
		const encoder = new TextEncoder()
		let index = 0
		const stream = new ReadableStream({
			pull(controller) {
				if (mode === 'drop' && index >= frames.length) {
					controller.error(new Error('fixture disconnected'))
					return
				}
				if (index < frames.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[index++])}\n\n`))
				else {
					controller.enqueue(encoder.encode('data: [DONE]\n\n'))
					controller.close()
				}
			},
		})
		return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
	}

	function scriptFor(payload) {
		const scripts = JSON.parse(readFileSync(scriptsFile, 'utf8'))
		// 请求体不含作品编号，用「历史范围 + 章节编号」定位编排规则，大纲（提案）请求用 outline 段；缺规则直接失败而不是回退默认响应。
		const key = `${payload.scope?.startYear}-${payload.scope?.endYear}|${payload.chapter?.id ?? 'outline'}`
		const script = scripts[key]
		assert.ok(Array.isArray(script) && script.length, `没有为 ${key} 编排假模型响应`)
		const round = (rounds.get(key) ?? 0) + 1
		rounds.set(key, round)
		assert.ok(round <= script.length, `${key} 第 ${round} 次请求超出编排的 ${script.length} 段：产品侧多发了模型请求`)
		return { mode: script[round - 1], key, round }
	}
} else {
	const directory = process.env.HISTORY_DATA_DIR
	if (!directory) throw new Error('请设置 HISTORY_DATA_DIR 指向隔离副本（含已登记古籍与参考小说）后再运行本回归。')
	const scriptsFile = path.join(directory, 'creation-chain-scripts.json')
	const requestLog = path.join(directory, 'creation-chain-requests.jsonl')
	const readyFile = path.join(directory, 'creation-chain-ready')
	const buildLock = path.join(process.cwd(), '.next-test.lock')
	// 规则按「起始年-结束年|章节编号」编排，父进程在每次生成前重写这份文件。
	const scripts = {}
	let server
	let logs = ''
	let locked = false

	function saveScripts() {
		// 子进程每个请求都读这份文件，写一半会让它解析失败：先写临时文件再原子改名。
		const temp = `${scriptsFile}.${process.pid}.tmp`
		writeFileSync(temp, `${JSON.stringify(scripts)}\n`)
		renameSync(temp, scriptsFile)
	}

	function sent(startYear, endYear, chapterId) {
		if (!existsSync(requestLog)) return []
		return readFileSync(requestLog, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter(
				(payload) =>
					payload.scope?.startYear === startYear && payload.scope?.endYear === endYear && (!chapterId || payload.chapter?.id === chapterId),
			)
	}

	const socket = createServer()
	socket.listen(0, '127.0.0.1')
	await once(socket, 'listening')
	const port = socket.address().port
	await new Promise((resolve) => socket.close(resolve))
	const base = `http://127.0.0.1:${port}`

	async function start() {
		// 构建产物目录与其他回归脚本共用，并发跑会互相破坏缓存：占不到锁就明确报错退出。
		if (existsSync(buildLock)) {
			const holder = Number(readFileSync(buildLock, 'utf8'))
			let alive = false
			try {
				process.kill(holder, 0)
				alive = true
			} catch {
				alive = false
			}
			if (alive) throw new Error(`另一个回归脚本正在使用 .next-test 构建目录（PID ${holder}），请串行运行。`)
			rmSync(buildLock, { force: true })
		}
		writeFileSync(buildLock, `${process.pid}\n`)
		locked = true
		saveScripts()
		server = spawn(
			process.execPath,
			['--import', fileURLToPath(import.meta.url), 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
			{
				cwd: process.cwd(),
				detached: true,
				env: {
					...process.env,
					HISTORY_TEST_BUILD: '1',
					HISTORY_DATA_DIR: directory,
					CREATION_CHAIN_FIXTURE: '1',
					CREATION_CHAIN_REQUEST_LOG: requestLog,
					CREATION_CHAIN_SCRIPTS: scriptsFile,
					CREATION_CHAIN_READY: readyFile,
					DASHSCOPE_API_KEY: 'fixture-only',
					BAILIAN_BASE_URL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
					BAILIAN_MODEL_WRITING: 'qwen3.8-max',
					NEXT_TELEMETRY_DISABLED: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		await new Promise((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error('假模型流服务启动超时')), 60000)
			const capture = (chunk) => {
				logs = (logs + chunk.toString()).slice(-8000)
				if (logs.includes('Ready in')) {
					clearTimeout(deadline)
					resolve()
				}
			}
			server.stdout.on('data', capture)
			server.stderr.on('data', capture)
			server.once('exit', (code) => {
				clearTimeout(deadline)
				reject(new Error(`假模型流服务提前退出：${code}\n${logs}`))
			})
		})
		assert.ok(existsSync(readyFile), '服务进程未装载假模型拦截器，零请求断言不可信')
	}

	async function stop() {
		if (!server || server.exitCode !== null) return
		const exited = once(server, 'exit')
		process.kill(-server.pid, 'SIGTERM')
		await exited
	}

	async function call(route, body, expected = 200, method) {
		const isGet = body === undefined
		const response = await fetch(`${base}${route}`, {
			method: isGet ? 'GET' : (method ?? 'POST'),
			headers: { origin: base, 'content-type': 'application/json' },
			body: isGet ? undefined : JSON.stringify(body),
		})
		const data = await response.json()
		assert.equal(response.status, expected, `${route} -> ${JSON.stringify(data)}`)
		return data
	}

	// 页面路由只核对可达性（深链、刷新、跨作品 404）。
	async function page(route, expected) {
		const response = await fetch(`${base}${route}`)
		await response.text()
		assert.equal(response.status, expected, `${route} 应返回 ${expected}`)
	}

	async function attempt(route, body, pattern, expected = 400, method) {
		const data = await call(route, body, expected, method)
		assert.match(String(data.error), pattern, `${route} 的拒绝口径：${JSON.stringify(data)}`)
		return data
	}

	async function waitFor(route, chapterId, expected) {
		const deadline = Date.now() + 30000
		let last = null
		while (Date.now() < deadline) {
			const state = await call(route)
			last = state.chapters.find((item) => item.chapterId === chapterId)
			if (last?.status === expected) return state
			await new Promise((resolve) => setTimeout(resolve, 120))
		}
		throw new Error(`${chapterId} 未在限定时间内进入 ${expected}，当前状态 ${last?.status}，错误信息：${last?.errorMessage ?? '无'}`)
	}

	function routes(id) {
		return {
			scope: `/api/projects/${id}/scope`,
			corpus: `/api/projects/${id}/corpus`,
			persons: `/api/projects/${id}/persons`,
			documents: `/api/projects/${id}/documents`,
			setup: `/api/projects/${id}/setup`,
			events: `/api/projects/${id}/events`,
			references: `/api/projects/${id}/references`,
			proposals: `/api/projects/${id}/proposals`,
			outline: `/api/projects/${id}/outline`,
			story: `/api/projects/${id}/story`,
		}
	}

	async function createProject(name) {
		const created = await call('/api/projects', { name }, 201)
		return { id: created.project.id, routes: routes(created.project.id) }
	}

	async function putScope(project, startYear, endYear) {
		await call(project.routes.scope, { startYear, endYear, region: '汴州、洛阳' }, 200, 'PUT')
	}

	async function uploadText(project, filename, content) {
		const form = new FormData()
		form.append('category', 'history')
		form.append('file', new File([content], filename, { type: 'text/plain' }))
		const upload = await fetch(`${base}${project.routes.documents}`, { method: 'POST', headers: { origin: base }, body: form })
		assert.equal(upload.status, 201, await upload.text())
		return (await call(project.routes.documents)).documents.find((item) => item.filename === filename).id
	}

	async function uploadChronicle(project) {
		return uploadText(project, 'chronicle.txt', chronicled)
	}

	// 证据必须逐次显式传入：不同人物挂在不同书目上，隐式默认会让「证据命中原文」的断言悄悄失效。
	async function addPerson(project, documentId, name, year, region, evidence) {
		await call(project.routes.setup, {
			action: 'person',
			name,
			start: String(year),
			end: String(year),
			region,
			documentId,
			evidence,
			confirmed: true,
		})
		const person = (await call(project.routes.setup)).people.find((item) => item.name === name)
		await call(project.routes.setup, { action: 'select', id: person.id, selected: true })
		return person
	}

	// 参考小说：新建作品会自动固定登记卷次，未确认写作规格时章纲与正文都进不去（REQ-010、REQ-046）。
	async function confirmReference(project) {
		const references = await call(project.routes.references)
		assert.ok(references.pinned, '本机需已登记参考小说，否则规格分支不会被覆盖')
		if (references.pinned.version === null) {
			await call(project.routes.references, { action: 'confirmSpec', version: references.pinned.pendingVersion })
		}
		return (await call(project.routes.references)).pinned
	}

	// 零 Token 的本地链路：提案 → 选定 → 骨架章纲（REQ-054、REQ-056）。
	async function firstOutline(project, plannedChapters) {
		await call(project.routes.proposals, { action: 'local' })
		await call(project.routes.proposals, { action: 'select', slot: 1 })
		return skeletonOutline(project, plannedChapters)
	}

	async function skeletonOutline(project, plannedChapters) {
		await call(project.routes.outline, { action: 'skeleton', plannedChapters })
		return call(project.routes.story)
	}

	function withDatabase(run) {
		const database = new Database(path.join(directory, 'workspace.sqlite'))
		database.pragma('busy_timeout = 5000')
		try {
			return run(database)
		} finally {
			database.close()
		}
	}

	// 场景 B 的旧数据只能直接写库构造：模拟改版前落库的派生已采用事件（待复核）与自动共现关系（年份已被清空）。
	function insertLegacyRows(projectId, documentId, personIds) {
		const legacy = [
			{ id: randomUUID(), title: '旧派生·汴州兵变', start: 905, end: 905, sourceKey: 'legacy:derived-bian' },
			{ id: randomUUID(), title: '旧派生·远期记事', start: 999, end: 999, sourceKey: 'legacy:derived-far' },
		]
		const relationId = randomUUID()
		withDatabase((database) => {
			const now = new Date().toISOString()
			const insert = database.prepare(
				`INSERT INTO plot_events(id, project_id, title, summary, kind, status, origin, source_key, document_id, evidence, region, start_year, end_year, created_at, updated_at, needs_review, verified_at)
				 VALUES (?, ?, ?, ?, 'historical', 'adopted', 'derived', ?, ?, ?, '汴州', ?, ?, ?, ?, 1, NULL)`,
			)
			for (const item of legacy) {
				insert.run(item.id, projectId, item.title, '改版前自动派生的事件摘要。', item.sourceKey, documentId, chronicled, item.start, item.end, now, now)
				database.prepare('INSERT INTO plot_event_participants(event_id, character_id, participation) VALUES (?, ?, ?)').run(item.id, personIds[0], '出席')
			}
			database
				.prepare(
					"INSERT INTO historical_relations(id, project_id, from_id, to_id, label, document_id, evidence, start_year, end_year, review_status) VALUES (?, ?, ?, ?, '史料共现', ?, ?, NULL, NULL, 'auto')",
				)
				.run(relationId, projectId, personIds[0], personIds[1], documentId, chronicled)
		})
		return { legacy, relationId }
	}

	// SC-009：参考小说原文与原作人名/地名一律不得进入大纲与正文请求。取样必须来自作品实际固定的系列。
	function referenceGuards(pinned) {
		const row = withDatabase((database) =>
			database
				.prepare('SELECT series, text_path AS textPath FROM reference_novel WHERE series_key = ? ORDER BY volume_order LIMIT 1')
				.get(pinned.seriesKey),
		)
		assert.ok(row, `本机需登记参考小说系列「${pinned.series}」的原文`)
		assert.equal(row.series, pinned.series, '取样书目应与作品固定的参考小说系列一致')
		const text = readFileSync(path.resolve(process.cwd(), row.textPath), 'utf8')
		const excerpt = text.slice(20000, 20060)
		assert.equal(excerpt.length, 60, '参考原文取样长度异常，请改用更靠前的稳定段落')
		assert.ok(/[\u4e00-\u9fa5]{10,}/.test(excerpt), '参考原文取样需含成段中文')
		const names = ['丹妮莉丝', '琼恩', '维斯特洛', '劳勃', '奈德'].filter((name) => text.includes(name))
		assert.ok(names.length >= 2, '参考原文取样应含可核对的原作人名')
		return { series: row.series, excerpt, names }
	}

	function assertNoReferenceText(payloads, guard) {
		assert.ok(payloads.length > 0, '需有请求可核对')
		for (const payload of payloads) {
			const raw = JSON.stringify(payload)
			assert.ok(!raw.includes(guard.excerpt), '模型请求不得携带参考小说原文')
			for (const name of guard.names) assert.ok(!raw.includes(name), `模型请求不得出现原作人物「${name}」`)
			// 正文请求用 referenceSpecification，提案（大纲）请求用 writingSpecification，两者都必带。
			const specification = payload.referenceSpecification ?? payload.writingSpecification
			const specificationVersion = payload.referenceSpecVersion ?? payload.writingSpecVersion
			assert.match(String(specification), /\S/, '模型请求需携带抽象写作规格')
			assert.ok(Number.isInteger(specificationVersion), '模型请求需记录生效的规格版本')
		}
	}

	// 两个场景的历史范围只在这里出现一次：编排键、putScope 与请求计数共用同一份口径。
	const scopeA = { start: 904, end: 904 }
	const scopeB = { start: 900, end: 910 }
	const scriptKey = (scope, chapterId) => `${scope.start}-${scope.end}|${chapterId}`
	const sentA = (chapterId) => sent(scopeA.start, scopeA.end, chapterId)
	const sentB = (chapterId) => sent(scopeB.start, scopeB.end, chapterId)

	const created = []
	try {
		rmSync(requestLog, { force: true })
		rmSync(readyFile, { force: true })
		await start()

		// ———— 场景 A：按单年选用本机古籍、人物事件与参考小说 ————
		const project = await createProject('创作链回归·单年汴州')
		created.push(project.id)
		await putScope(project, scopeB.start, scopeB.end)
		await call(project.routes.corpus, { action: 'pin' })
		const corpusWide = await call(project.routes.corpus)
		const personsWide = await call(`${project.routes.persons}?limit=400`)
		assert.ok(corpusWide.ready && corpusWide.pinning.books.length > 0 && corpusWide.personsIndexed, '隔离副本需已入库古籍、固定到作品并完成人物索引')
		assert.ok(personsWide.candidates.length > 0 && personsWide.books.length > 0, '史料人物候选为空')
		await putScope(project, scopeA.start, scopeA.end)
		const corpusNarrow = await call(project.routes.corpus)
		const personsNarrow = await call(`${project.routes.persons}?limit=400`)
		// REQ-046：单年只选用覆盖该年的古籍，年份外的书目与人物不进入候选。
		assert.ok(
			corpusNarrow.scopeBooks.length > 0 && corpusNarrow.scopeBooks.length < corpusWide.scopeBooks.length,
			`年份外古籍不得混入单年候选（${corpusNarrow.scopeBooks.length}/${corpusWide.scopeBooks.length}）`,
		)
		assert.ok(corpusWide.scopeBooks.length > 0, '宽范围下应能选出覆盖唐末五代的古籍')
		for (const book of corpusNarrow.scopeBooks) {
			assert.ok(book.startYear <= scopeA.start && book.endYear >= scopeA.end, `${book.name} 不覆盖所选单年`)
		}
		const narrowNames = new Set(personsNarrow.candidates.map((item) => item.name))
		const outsideYear = [...new Set(personsWide.candidates.map((item) => item.name))].filter((name) => !narrowNames.has(name))
		assert.ok(outsideYear.length > 0, '单年候选应排除只在其他年份出现的人物')
		const skippedImport = await call(project.routes.persons, { action: 'import', names: [outsideYear[0]] })
		assert.deepEqual(skippedImport.inserted, [], `年份外人物「${outsideYear[0]}」不得导入`)
		assert.match(String(skippedImport.skipped[0].reason), /不在当前时间阶段/, '年份外人物需给出跳过原因')

		const documentId = await uploadChronicle(project)
		const zhu = await addPerson(project, documentId, '朱全忠', 904, '汴州', chronicled)
		const li = await addPerson(project, documentId, '李克用', 904, '洛阳', chronicled)
		await call(project.routes.setup, {
			action: 'relation',
			from: zhu.id,
			to: li.id,
			label: '彼此讨伐',
			start: '904',
			end: '904',
			documentId,
			evidence: chronicled,
			confirmed: true,
		})
		// SC-013：同一个单年还要从本机古籍里选人物与事件，出处需指向固定语料而不是上传件。
		let corpusPerson = null
		for (const candidate of personsNarrow.candidates.filter((item) => item.name !== '朱全忠' && item.name !== '李克用').slice(0, 12)) {
			const imported = await call(project.routes.persons, { action: 'import', names: [candidate.name], selectedNames: [candidate.name] })
			if (imported.inserted.length) {
				corpusPerson = (await call(project.routes.setup)).people.find((item) => item.name === candidate.name)
				break
			}
		}
		assert.ok(corpusPerson, '覆盖所选单年的古籍人物应至少可导入一位')
		await call(project.routes.events, { action: 'adopt', sourceKey: `activity:${corpusPerson.id}`, confirmed: true })
		const eventView = await call(project.routes.events)
		const sourceIds = new Map(eventView.sources.map((item) => [item.id, item]))
		for (const item of eventView.events) {
			assert.ok(item.documentId && sourceIds.has(item.documentId), `${item.title} 缺少出处资料`)
		}
		const corpusEvent = eventView.events.find((item) => item.sourceKey === `activity:${corpusPerson.id}`)
		assert.equal(sourceIds.get(corpusEvent.documentId).kind, 'corpus', '古籍事件的出处应来自固定语料')
		await call(project.routes.events, { action: 'adopt', sourceKey: `activity:${zhu.id}`, confirmed: true })
		await call(project.routes.events, { action: 'adopt', sourceKey: `activity:${li.id}`, confirmed: true })
		// SC-013：范围外的事件被拒绝保存，不会悄悄混进单年选题。
		await attempt(
			project.routes.events,
			{ action: 'add', title: '潞州之战', kind: 'historical', start: 906, end: 906, documentId, evidence: chronicled, confirmed: true, participants: [li.id] },
			/历史范围/,
		)
		await call(project.routes.events, {
			action: 'add',
			title: '汴州军议',
			kind: 'historical',
			start: 904,
			end: 904,
			documentId,
			evidence: chronicled,
			confirmed: true,
			participants: [zhu.id],
		})
		await call(project.routes.events, {
			action: 'add',
			title: '内殿对质',
			kind: 'historical',
			start: 904,
			end: 904,
			documentId,
			evidence: chronicled,
			confirmed: true,
			participants: [zhu.id, li.id],
		})
		assert.equal((await call(project.routes.outline)).evidence.length, 5, '单年范围内应有五条已采用史实')

		const reference = await confirmReference(project)
		const guard = referenceGuards(reference)
		let state = await firstOutline(project, 3)
		const [one, two, three] = state.plan.chapters.map((item) => item.id)
		const request = { version: state.version, planHash: state.planHash }
		const chapter = (id, list = state) => list.chapters.find((item) => item.chapterId === id)
		assert.equal(state.proposalIssue, null, '骨架章纲应绑定选定提案')
		assert.deepEqual(state.evidenceIssues, [], '新链路的证据无需复核')
		assert.deepEqual(
			[state.plan.generationContext.scope.startYear, state.plan.generationContext.scope.endYear],
			[904, 904],
			'章纲快照应记录所选单年',
		)
		assert.equal(state.plan.generationContext.reference.specVersion, reference.version, '章纲快照需绑定已确认的写作规格版本')
		assert.equal(state.evidence.length, 5, '章纲依据逐条列出')
		for (const item of state.evidence) {
			// 每条依据都带上出处资料名与原文摘录，作者可据此回查。
			assert.ok(item.title.includes('／'), `${item.title} 未标注史料出处`)
			assert.equal(item.status, 'confirmed')
		}
		const corpusSourceTitle = sourceIds.get(corpusEvent.documentId).title
		assert.ok(
			state.evidence.some((item) => item.title.startsWith(`${corpusSourceTitle}／`)),
			`章纲依据应包含固定语料《${corpusSourceTitle}》的条目`,
		)
		assert.match(state.plan.generationContext.associationPreview, /朱全忠与李克用/, '已核定关系应进入章纲快照')

		// ———— SC-002 / SC-012：未确认、未同意外发、版本不匹配一律拒绝且不发出任何请求 ————
		await attempt(project.routes.story, { ...request, chapterId: one, action: 'generate' }, /请先核对史料/, 409)
		await attempt(project.routes.story, { ...request, action: 'approve', allowExternalTransfer: false, evidenceConfirmed: true }, /资料外发/)
		await attempt(project.routes.story, { ...request, action: 'approve', allowExternalTransfer: true }, /资料外发/)
		await attempt(project.routes.story, { ...request, version: request.version + 1, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true }, /规划已变化/, 409)
		await attempt(project.routes.story, { ...request, planHash: 'deadbeef', action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true }, /规划已变化/, 409)
		assert.equal(sentA().length, 0, '门禁拦截期间一条模型请求都不发出')
		// REQ-035：确认方案不要求整书预算，只固定当前哈希与外发、证据核对口径。
		await call(project.routes.story, { ...request, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })
		scripts[scriptKey(scopeA, one)] = ['truncate', 'finish-truncated']
		scripts[scriptKey(scopeA, two)] = ['drop', 'finish-dropped']
		scripts[scriptKey(scopeA, three)] = ['plain']
		saveScripts()

		// ———— SC-005：只有明确长度截断才自动续写 ————
		assert.equal((await call(project.routes.story, { ...request, chapterId: one, action: 'generate' }, 202)).status, 'generating')
		state = await waitFor(project.routes.story, one, 'draft')
		assert.equal(chapter(one).content, truncatedText + finishTruncatedText, '自动续写只接在截断正文之后')
		assert.ok(!chapter(one).content.includes('[[META]]'), '元信息标记不得留在正文里')
		assert.equal(chapter(one).attemptCount, 2, '截断与收尾各留一条请求记录')
		assert.equal(chapter(one).autoContinuations, 1)
		const firstRounds = sentA(one)
		assert.equal(firstRounds.length, 2)
		assert.equal(firstRounds[1].continuation.savedText, truncatedText, '自动续写带上的应是已保存正文')
		await call(project.routes.story, { ...request, chapterId: one, action: 'accept' })
		state = await call(project.routes.story)
		assert.equal(chapter(one).status, 'accepted')
		assert.equal(state.storyStates.length, 1)
		assert.equal(state.storyStates[0].status, 'confirmed')
		assert.equal(state.storyStates[0].summary, stateSummary, '接受本章时固化收束状态')

		// ———— SC-005 / REQ-027：断线保留检查点，人工确认后才从末尾续写 ————
		await call(project.routes.story, { ...request, chapterId: two, action: 'generate' }, 202)
		state = await waitFor(project.routes.story, two, 'failed-or-unknown')
		assert.equal(chapter(two).content, droppedText, '断线时的检查点正文必须保留')
		await attempt(project.routes.story, { ...request, chapterId: two, action: 'resume' }, /核对百炼请求记录/)
		await call(project.routes.story, { ...request, chapterId: two, action: 'resume', retryConfirmed: true }, 202)
		state = await waitFor(project.routes.story, two, 'draft')
		assert.equal(chapter(two).content, droppedText + finishDroppedText, '人工续写接在检查点末尾而不是重写')
		assert.equal(chapter(two).autoContinuations, 0, '人工续写不计入自动续写次数')

		// ———— SC-009：各章请求使用同一已确认规格版本，且不含参考小说原文 ————
		const secondRounds = sentA(two)
		assert.equal(secondRounds.length, 2)
		assertNoReferenceText(sentA(), guard)
		for (const payload of [...firstRounds, ...secondRounds]) {
			assert.equal(payload.referenceSpecVersion, reference.version, '各章请求需使用同一已确认规格版本')
			assert.equal(payload.referenceSpecification, reference.specText)
			assert.deepEqual(payload.referenceMethods, reference.methods)
		}
		// REQ-025：第二章带入第一章已确认状态与前章正文尾部。
		const continuity = secondRounds[0]
		const labelOf = (index) => `第 ${index + 1} 章《${state.plan.chapters[index].title.slice(0, 40)}》`
		assert.equal(continuity.confirmedStoryState.usedInputs.length, 1)
		assert.equal(continuity.confirmedStoryState.usedInputs[0].chapter, labelOf(0))
		assert.deepEqual(continuity.excludedStoryState, [], '没有前文变更时不应排除任何状态')
		assert.equal(continuity.previousChapter.bodyTail, truncatedText + finishTruncatedText, '前章正文尾部应完整带入')
		assert.ok(continuity.evidence.length > 0, '每章只带本章绑定的依据')
		await call(project.routes.story, { ...request, chapterId: two, action: 'accept' })
		state = await call(project.routes.story)
		assert.equal(state.storyStates.filter((item) => item.status === 'confirmed').length, 2, '连续两章各自固化状态')

		// ———— SC-004：改写第一章后，依赖项转为待复核且已写文本不丢失 ————
		const beforeTwo = chapter(two).content
		await call(project.routes.story, { ...request, chapterId: one, action: 'edit', content: truncatedText + finishTruncatedText + '（人工改写第一章）' })
		state = await call(project.routes.story)
		assert.equal(chapter(one).status, 'draft', '改写已接受章节后本章回到待接受状态')
		assert.equal(chapter(two).needsReview, 1, '依赖前文的章节转为待复核')
		assert.equal(chapter(two).content, beforeTwo, '待复核章节的已写文本一律保留，不自动重写')
		assert.equal(
			state.storyStates.filter((item) => item.status === 'stale').length,
			2,
			'被改写章节与其后章节的状态全部转为已失效',
		)
		await attempt(project.routes.story, { ...request, chapterId: three, action: 'generate' }, /请先完成人工编辑并接受前一章/, 409)
		await call(project.routes.story, { ...request, chapterId: one, action: 'accept' })
		state = await call(project.routes.story)
		assert.equal(chapter(one).status, 'accepted', '改写后的第一章重新接受')
		assert.equal(chapter(two).needsReview, 1, '前章重新接受不代替本章复核')
		await attempt(project.routes.story, { ...request, chapterId: three, action: 'generate' }, /因前文变更待复核/, 409)
		assert.equal(sentA(three).length, 0, '待复核期间不得为后续章节发出请求')
		await call(project.routes.story, { ...request, chapterId: two, action: 'accept' })
		state = await call(project.routes.story)
		assert.equal(chapter(two).needsReview, 0, '重新接受即完成本章复核，无需重写正文')

		// 逐章复核后可继续生成下一章，带入的是改写后的状态。
		await call(project.routes.story, { ...request, chapterId: three, action: 'generate' }, 202)
		state = await waitFor(project.routes.story, three, 'draft')
		assert.equal(chapter(three).content, wholeText)
		const third = sentA(three)[0]
		assert.deepEqual(
			third.confirmedStoryState.usedInputs.map((item) => item.chapter),
			[labelOf(0), labelOf(1)],
			'第三章带入前两章复核后的状态',
		)
		assert.deepEqual(third.excludedStoryState, [], '已失效内容复核后不再被排除')
		assert.equal(third.previousChapter.bodyTail, droppedText + finishDroppedText, '前章正文尾部随复核后的状态一并带入')
		await call(project.routes.story, { ...request, chapterId: three, action: 'accept' })

		// ———— SC-009：大纲请求与正文请求使用同一份已确认规格；改版后只提示复核、不阻断 ————
		scripts[scriptKey(scopeA, 'outline')] = ['proposals']
		saveScripts()
		const outlineRun = await call(project.routes.proposals, { action: 'generate', allowExternalTransfer: true })
		assert.equal(outlineRun.proposals.length, 3, '模型应返回三份可比提案')
		const outlinePayload = sentA().find((payload) => !payload.chapter)
		assert.ok(outlinePayload, '大纲请求应留下记录')
		assert.equal(outlinePayload.writingSpecVersion, reference.version, '大纲请求应记录已确认的规格版本')
		assert.equal(outlinePayload.writingSpecification, third.referenceSpecification, '大纲与正文使用同一份抽象规格')
		assert.equal((await call(project.routes.story)).proposalIssue, null, '模型提案不覆盖已选定方案')
		// 作者直接改写并确认新的规格版本：旧方案沿用原版本，只给出复核提示，不影响已接受章节。
		const savedSpec = await call(project.routes.references, {
			action: 'saveSpec',
			specText: `${reference.specText}\n作者补充：叙述保持白话。`,
			methods: reference.methods,
		})
		await call(project.routes.references, { action: 'confirmSpec', version: savedSpec.version })
		const drifted = await call(project.routes.story)
		assert.match(String(drifted.specNotice), /规格/, '规格改版后应提示复核')
		assert.ok(drifted.specNotice.includes(`v${reference.version}`), '提示应写明方案沿用的规格版本')
		assert.deepEqual(
			drifted.chapters.filter((item) => item.status === 'accepted').map((item) => item.chapterId).sort(),
			[one, two, three].sort(),
			'规格改版不撤掉已接受章节',
		)
		assert.equal(sentA(three).length, 1, '规格改版不会自动重发正文请求')

		// ———— SC-013：深链可达、刷新结果一致 ————
		await page(`/projects/${project.id}/chapters/${one}`, 200)
		await page(`/projects/${project.id}/chapters/${three}`, 200)
		await page(`/projects/${project.id}/setup/outline`, 200)
		const reloaded = await call(project.routes.story)
		assert.equal(reloaded.version, state.version, '刷新后仍是同一规划版本')
		assert.equal(reloaded.planHash, state.planHash)
		assert.equal(reloaded.chapters.find((item) => item.chapterId === two).content, beforeTwo, '刷新后已写正文可回看')

		// ———— SC-013：跨作品读写互相隔离 ————
		const requestsBeforeIsolation = sentA().length
		const other = await createProject('创作链回归·隔离对照')
		created.push(other.id)
		const emptyStory = await call(other.routes.story)
		assert.equal(emptyStory.plan, null)
		assert.deepEqual(emptyStory.chapters, [])
		await attempt(
			other.routes.events,
			{ action: 'add', title: '借用他作史料', kind: 'historical', start: 904, end: 904, documentId, evidence: chronicled, confirmed: true },
			/历史资料原文/,
		)
		await attempt(other.routes.story, { version: 1, planHash: state.planHash, chapterId: one, action: 'accept' }, /规划已变化/, 409)
		await page(`/projects/${other.id}/chapters/${one}`, 404)
		assert.deepEqual((await call(other.routes.events)).events, [], '他作读不到本作品的历史事件')
		assert.equal(sentA().length, requestsBeforeIsolation, '跨作品尝试不应产生任何模型请求')

		// ———— 场景 B：含旧派生事件与自动共现关系的作品 ————
		const legacyProject = await createProject('创作链回归·旧派生数据')
		created.push(legacyProject.id)
		await putScope(legacyProject, scopeB.start, scopeB.end)
		await call(legacyProject.routes.corpus, { action: 'pin' })
		const legacyDoc = await uploadChronicle(legacyProject)
		const legacyPeopleDoc = await uploadText(legacyProject, 'other-chronicle.txt', chronicledOther)
		// 人物换用别的名字：与场景 A 同名会让「请求只带本作品已勾选人物」失去区分力。
		const legacyZhu = await addPerson(legacyProject, legacyPeopleDoc, '朱友恭', 903, '汴州', chronicledOther)
		const legacyLi = await addPerson(legacyProject, legacyPeopleDoc, '氏叔琮', 903, '洛阳', chronicledOther)
		await call(legacyProject.routes.events, { action: 'adopt', sourceKey: `activity:${legacyZhu.id}`, confirmed: true })
		await call(legacyProject.routes.events, { action: 'adopt', sourceKey: `activity:${legacyLi.id}`, confirmed: true })
		const { legacy, relationId } = insertLegacyRows(legacyProject.id, legacyDoc, [legacyZhu.id, legacyLi.id])
		const legacyReference = await confirmReference(legacyProject)
		assert.equal(legacyReference.seriesKey, reference.seriesKey, '两个作品固定同一套参考小说，规格口径才可比')
		let legacyState = await firstOutline(legacyProject, 3)
		const [legacyOne, legacyTwo] = legacyState.plan.chapters.map((item) => item.id)
		const legacyRequest = { version: legacyState.version, planHash: legacyState.planHash }
		const legacyTitles = legacy.map((item) => item.title)
		// 第一章会在重新确认方案后再生成一次，编排两段；第二章只需一段。
		scripts[scriptKey(scopeB, legacyOne)] = ['plain', 'plain']
		scripts[scriptKey(scopeB, legacyTwo)] = ['plain']
		saveScripts()
		// SC-013：未核对的旧派生事件不参与编排，也不进入生成上下文。
		assert.equal(legacyState.plan.chapters.length, 2, '只有已核对的史实参与章节编排')
		assert.equal(legacyState.evidence.length, 2, '待复核旧事件不进入章纲依据')
		assert.ok(!JSON.stringify(legacyState.plan.generationContext).includes('旧派生'), '待复核旧事件不进入生成上下文')
		assert.ok(!legacyState.plan.generationContext.associationPreview.includes('史料共现'), '未确认的自动共现关系不得进入生成上下文')
		// 旧稿仍可打开：事件与年代、原文摘录都在，只是标着待复核。
		const stored = await call(legacyProject.routes.events)
		for (const item of legacy) {
			const row = stored.events.find((event) => event.title === item.title)
			assert.ok(row, `${item.title} 应仍能打开`)
			assert.equal(row.needsReview, true, '旧派生事件在迁移后标记为待复核')
			assert.ok(row.evidence.includes('汴州') || row.evidence.includes('内殿'), '旧事件仍需保留原文摘录')
		}
		assert.equal(stored.events.find((event) => event.title === legacy[1].title).end, 999, '旧事件的年代在核对前原样保留')
		assert.equal((await call(legacyProject.routes.setup)).relations.find((item) => item.id === relationId).reviewStatus, 'auto', '待核线索仍可在工作台核对')
		// 已核对的部分不受影响，可以继续写。
		await call(legacyProject.routes.story, { ...legacyRequest, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })
		await call(legacyProject.routes.story, { ...legacyRequest, chapterId: legacyOne, action: 'generate' }, 202)
		legacyState = await waitFor(legacyProject.routes.story, legacyOne, 'draft')
		assert.equal(legacyState.chapters.find((item) => item.chapterId === legacyOne).content, wholeText, '旧数据作品的第一章来自一次成稿')
		await call(legacyProject.routes.story, { ...legacyRequest, chapterId: legacyOne, action: 'accept' })
		const legacyFirst = sentB(legacyOne)[0]
		assert.equal(sentB().length, 1, '只发出本章的一次请求')
		for (const title of legacyTitles) {
			assert.ok(!JSON.stringify(legacyFirst.evidence).includes(title), `未核对的「${title}」不得进入正文请求`)
		}
		assert.ok(!legacyFirst.associationPreview.includes('史料共现'), '未核对的关系不得随请求外送')

		// T050/REQ-028：方案确认后抽掉一条方案依赖的已采用事件，证据复核要立刻拦下生成。
		const legacyActivity = (await call(legacyProject.routes.events)).events.find((event) => event.sourceKey === `activity:${legacyZhu.id}`)
		assert.ok(legacyActivity, '人物活动应已采用为事件')
		await call(legacyProject.routes.events, { action: 'update', id: legacyActivity.id, status: 'reject' })
		const excludedView = await call(legacyProject.routes.story)
		assert.ok(
			excludedView.evidenceIssues.some((item) => /已被排除/.test(item)),
			'被排除的已采用事件应列为方案依赖问题',
		)
		// 证据变化同时让提案绑定失效，两条门禁都指向「重新确认方案」，都不发请求。
		await attempt(legacyProject.routes.story, { ...legacyRequest, chapterId: legacyTwo, action: 'generate' }, /重新确认|已变化|待复核|已被排除/, 409)
		assert.equal(sentB().length, 1, '方案依赖出问题期间不再发出请求')
		await call(legacyProject.routes.events, { action: 'update', id: legacyActivity.id, status: 'adopt', confirmed: true })
		assert.deepEqual((await call(legacyProject.routes.story)).evidenceIssues, [], '恢复采用后方案依赖重新成立')

		// 核对出处与年代：范围内那条直接确认；范围外那条无论确认还是原年代保存都被拒绝，修正后才通过。
		await call(legacyProject.routes.events, { action: 'verify', id: legacy[0].id, confirmed: true })
		await attempt(legacyProject.routes.events, { action: 'verify', id: legacy[1].id, confirmed: true }, /历史范围/)
		await attempt(
			legacyProject.routes.events,
			{ action: 'update', id: legacy[1].id, title: legacy[1].title, kind: 'historical', start: 999, end: 999, documentId: legacyDoc, evidence: chronicled, confirmed: true },
			/历史范围/,
		)
		await call(legacyProject.routes.events, {
			action: 'update',
			id: legacy[1].id,
			title: legacy[1].title,
			kind: 'historical',
			start: 906,
			end: 906,
			documentId: legacyDoc,
			evidence: chronicled,
			confirmed: true,
			participants: [legacyLi.id],
		})
		await call(legacyProject.routes.setup, { action: 'confirmRelation', id: relationId, start: '904', end: '905', confirmed: true })
		await attempt(legacyProject.routes.setup, { action: 'confirmRelation', id: relationId, start: '904', end: '905', confirmed: true }, /已核对过/)

		// 核对改变了章纲赖以成立的输入：受影响方案必须重新确认，期间不再发出请求。
		await attempt(legacyProject.routes.story, { ...legacyRequest, chapterId: legacyTwo, action: 'generate' }, /已变化|重新生成/, 409)
		assert.equal(sentB().length, 1, '重新确认受影响方案前不再发出请求')
		const keptDraft = withDatabase((database) =>
			database.prepare('SELECT plan_version AS planVersion, content, status FROM chapter_drafts WHERE project_id = ? AND chapter_id = ?').get(legacyProject.id, legacyOne),
		)
		assert.equal(keptDraft.content, wholeText, '旧稿正文仍可查看')
		assert.equal(keptDraft.status, 'accepted')
		assert.equal(keptDraft.planVersion, legacyRequest.version)

		// 核对让提案输入随之变化：章纲要等剧情提案按新证据重新生成并选定后才能重排。
		await attempt(legacyProject.routes.outline, { action: 'skeleton', plannedChapters: 3 }, /已变化|重新生成/, 409)
		await call(legacyProject.routes.proposals, { action: 'unselect', slot: 1 })
		await call(legacyProject.routes.proposals, { action: 'local' })
		await call(legacyProject.routes.proposals, { action: 'select', slot: 1 })
		// 人工改写选定提案会另存新版本，改写前的正文仍可回看。
		const proposalBefore = (await call(legacyProject.routes.proposals)).selected
		await call(legacyProject.routes.proposals, {
			action: 'save',
			slot: proposalBefore.slot,
			proposal: { ...proposalBefore, title: `${proposalBefore.title}（作者改写）` },
		})
		// 重新确认受影响方案：按核对后的史实与新版提案重排章纲，再继续下一章。
		legacyState = await skeletonOutline(legacyProject, 3)
		assert.equal(legacyState.plan.chapters.length, 3, '核对通过的旧事件加入编排')
		assert.equal(legacyState.evidence.length, 4, '四条已核对史实成为章纲依据')
		for (const title of legacyTitles) {
			assert.ok(legacyState.evidence.some((item) => item.title.includes(title)), `「${title}」核对后应进入章纲依据`)
		}
		assert.deepEqual(legacyState.evidenceIssues, [], '核对完成后不再有等待项')
		const legacyConfirmed = { version: legacyState.version, planHash: legacyState.planHash }
		await call(legacyProject.routes.story, { ...legacyConfirmed, action: 'approve', allowExternalTransfer: true, evidenceConfirmed: true })
		// 改版把第一章已接受正文按章节继承到新版本，因此重写它要走显式「重新生成」并确认覆盖，而不是普通生成。
		await call(legacyProject.routes.story, { ...legacyConfirmed, chapterId: legacyOne, action: 'regenerate', regenerateConfirmed: true }, 202)
		await waitFor(legacyProject.routes.story, legacyOne, 'draft')
		await call(legacyProject.routes.story, { ...legacyConfirmed, chapterId: legacyOne, action: 'accept' })
		await call(legacyProject.routes.story, { ...legacyConfirmed, chapterId: legacyTwo, action: 'generate' }, 202)
		await waitFor(legacyProject.routes.story, legacyTwo, 'draft')
		const legacySent = sentB()
		assert.equal(legacySent.length, 3, '核对完成并重新确认方案后才发出后续请求')
		const archivedAttempts = withDatabase((database) =>
			database
				.prepare('SELECT plan_version AS planVersion, content FROM chapter_generation_attempts WHERE project_id = ? AND chapter_id = ? ORDER BY plan_version, attempt_number')
				.all(legacyProject.id, legacyOne),
		)
		assert.equal(archivedAttempts.length, 2, '重排章纲后的再次生成保留旧尝试记录')
		assert.equal(archivedAttempts[0].planVersion, legacyRequest.version, '核对前的尝试记录属于旧方案版本')
		assert.ok(archivedAttempts[0].content.startsWith(wholeText), '核对前的旧稿正文留档可回看（尝试记录保留模型原文与元信息段）')
		assertNoReferenceText(legacySent, guard)
		const legacySecond = legacySent.at(-1)
		assert.equal(legacySecond.chapter.id, legacyTwo)
		assert.equal(legacySecond.referenceSpecVersion, legacyReference.version)
		assert.ok(legacySecond.evidence.some((item) => item.title.includes(legacy[0].title)), '核对通过的旧派生事件进入本章依据')
		assert.match(legacySecond.associationPreview, /年前后 朱友恭与氏叔琮/, '核对并补上年月后的关系才进入请求')
		assert.deepEqual([...legacySecond.historicalCharacters].sort(), [...['朱友恭', '氏叔琮']].sort(), '请求只带本作品已勾选人物，不带场景 A 的人物')
		assert.equal(legacySecond.confirmedStoryState.usedInputs.length, 1, '第二章带入第一章已确认状态')
		const history = (await call(legacyProject.routes.proposals)).history.find((item) => item.slot === proposalBefore.slot)
		assert.ok(history.revisions.length >= 2, '提案历史版本应保留')
		assert.equal(history.revisions[0].title, `${proposalBefore.title}（作者改写）`, '改写后的提案成为当前版本')
		assert.ok(
			history.revisions.some((item) => item.title === proposalBefore.title),
			'改写前的提案正文仍可回看',
		)

		const totals = { singleYear: sentA().length, legacy: sentB().length }
		// 请求总数与编排段数比对：既不能少发（静默跳过），也不能多发（越权重发）。
		const scripted = Object.values(scripts).reduce((sum, item) => sum + item.length, 0)
		assert.equal(totals.singleYear + totals.legacy, scripted, '发出的模型请求数应与编排段数一致，一个不多一个不少')
		console.log(
			`PASS：单年选题+参考小说规格连续生成（截断自动续写、断线检查点与人工续写、前章状态与失效排除）、门禁零请求、大纲与正文同一规格且改版只提示复核、深链与跨作品隔离、旧派生事件与共现关系核对后放行、方案依赖变化拦下生成；共 ${totals.singleYear + totals.legacy} 次假模型请求，未使用真实 Key。`,
		)
	} catch (error) {
		console.error(logs)
		throw error
	} finally {
		await stop()
		// 只回收自己拿到的锁，不能让没跑起来的那次运行删掉正在跑的脚本的锁。
		if (locked) rmSync(buildLock, { force: true })
		if (created.length) {
			try {
				withDatabase((database) => {
					for (const id of created) cleanupStoryProject(database, id)
				})
			} catch (cleanupError) {
				console.error(`测试作品清理失败：${cleanupError.message}`)
			}
		}
		rmSync(requestLog, { force: true })
		rmSync(scriptsFile, { force: true })
		rmSync(readyFile, { force: true })
	}
}
