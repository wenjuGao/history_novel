// 章纲分组生成：计划章数放开到 1000，一次模型调用最多写 10 章，超出部分由界面逐组串行推进。
// 本脚本用 fixture 替换百炼，断言组数折算、跨组衔接、中途失败零落库，全程零真实模型调用。
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { seedStoryPlan } from './lib/story-chain.mjs'

const groupSize = 10
const planned = 25

if (process.env.OUTLINE_GROUPS_FIXTURE === '1') {
	const failFlag = process.env.OUTLINE_GROUPS_FAIL_FILE
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
		if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, options)
		assert.equal(url.hostname, 'token-plan.cn-beijing.maas.aliyuncs.com', 'Fixture refuses external network')
		assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-only')
		const body = JSON.parse(options.body)
		assert.notEqual(body.stream, true, '章纲调用是非流式 JSON')
		assert.equal(body.response_format.type, 'json_object')
		const payload = JSON.parse(body.messages[1].content)
		const range = payload.range
		assert.ok(range, '章纲请求必须标明本次编排的章节区间')
		// 模拟某组调用打到上游失败：服务端必须原样报「未写入任何规划」，让界面保留已生成章节。
		if (failFlag && existsSync(failFlag)) return new Response('{"error":{"message":"upstream exploded"}}', { status: 500 })
		if (process.env.OUTLINE_GROUPS_FIXTURE_LOG) {
			appendFileSync(
				process.env.OUTLINE_GROUPS_FIXTURE_LOG,
				`${JSON.stringify({
					from: range.from,
					to: range.to,
					totalChapters: range.totalChapters,
					groupSize: range.groupSize,
					generatedBefore: range.generatedBefore,
					instructions: payload.instructions,
					previousChapter: payload.previousChapter,
					bookTitle: payload.book?.title ?? null,
					maxTokens: body.max_tokens,
				})}\n`,
			)
		}
		const evidence = payload.evidence ?? []
		const count = range.to - range.from + 1
		// 故意用相对编号（chapter-01 起）回给服务端，验证合并时按全书位置重编号。
		const chapters = Array.from({ length: count }, (_, index) => ({
			id: `chapter-${String(index + 1).padStart(2, '0')}`,
			title: `分组章节 ${range.from + index}`,
			pov: '朱全忠',
			synopsis: `第 ${range.from + index} 章梗概。`,
			plot: [`情节一：第 ${range.from + index} 章的主要冲突。`],
			historyEvidence: [evidence[index % evidence.length]?.id ?? 'E1'],
			fiction: ['本章场景细节为虚构。'],
			endingHook: `第 ${range.from + index} 章的章末钩子。`,
		}))
		return Response.json({
			id: `fixture-outline-${range.from}`,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: JSON.stringify({
							schemaVersion: 2,
							title: `每组都换书名的模型（第 ${range.from} 组）`,
							synopsis: '两个势力在年号之间摇摆。',
							centralQuestion: '改元之后，旧年号还能用多久？',
							historicalAnchors: [{ evidenceId: evidence[0]?.id ?? 'E1', fact: '太祖以汴州为开国之地。' }],
							fictionBoundary: ['虚构不改动已核定史实。'],
							humanReviewQuestions: ['本章证据是否足够？'],
							chapters,
						}),
					},
					finish_reason: 'stop',
				},
			],
			usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
		})
	}
} else {
	// 空串按未设置处理：服务端用 `||` 判空，`HISTORY_DATA_DIR=` 会把测试作品写进真实 data/local。
	const seeded = process.env.HISTORY_DATA_DIR?.trim()
	const directory = seeded ? path.resolve(seeded) : mkdtempSync(path.join(os.tmpdir(), 'outline-groups-'))
	assert.notEqual(directory, path.resolve(process.cwd()), 'HISTORY_DATA_DIR 不能是仓库目录，请指向隔离副本或留空自建临时目录。')
	assert.notEqual(directory, path.resolve(process.cwd(), 'data', 'local'), 'HISTORY_DATA_DIR 不能指向真实工作区 data/local。')
	const socket = createServer()
	socket.listen(0, '127.0.0.1')
	await once(socket, 'listening')
	const port = socket.address().port
	await new Promise((resolve) => socket.close(resolve))
	const base = `http://127.0.0.1:${port}`
	const logFile = path.join(directory, 'requests.jsonl')
	const failFlag = path.join(directory, 'fail-upstream')
	let server
	let logs = ''
	let read

	async function start() {
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
					OUTLINE_GROUPS_FIXTURE: '1',
					OUTLINE_GROUPS_FIXTURE_LOG: logFile,
					OUTLINE_GROUPS_FAIL_FILE: failFlag,
					DASHSCOPE_API_KEY: 'fixture-only',
					BAILIAN_BASE_URL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
					BAILIAN_MODEL_WRITING: 'qwen3.8-max',
					NEXT_TELEMETRY_DISABLED: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		await new Promise((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error('Fixture server startup timed out')), 90000)
			const capture = (chunk) => {
				const text = chunk.toString()
				logs = (logs + text).slice(-6000)
				if (text.includes('Ready in')) {
					clearTimeout(deadline)
					resolve()
				}
			}
			server.stdout.on('data', capture)
			server.stderr.on('data', capture)
			server.once('exit', (code) => {
				clearTimeout(deadline)
				reject(new Error(`Fixture server exited: ${code}`))
			})
		})
	}

	async function stop() {
		if (!server || server.exitCode !== null) return
		const exited = once(server, 'exit')
		process.kill(-server.pid, 'SIGTERM')
		await exited
	}

	async function call(route, body, expected = 200, method) {
		const response = await fetch(base + route, {
			method: method ?? (body === undefined ? 'GET' : 'POST'),
			headers: { origin: base, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const data = await response.json()
		assert.equal(response.status, expected, `${route} -> ${JSON.stringify(data)}`)
		return data
	}

	function groupCalls() {
		if (!existsSync(logFile)) return []
		return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
	}

	function planRow(database, projectId) {
		return database.prepare('SELECT version, plan_json AS planJson FROM story_plans WHERE project_id = ?').get(projectId)
	}

	try {
		rmSync(logFile, { force: true })
		rmSync(failFlag, { force: true })
		await start()
		const chain = await seedStoryPlan(base, { name: '章纲分组生成测试', plannedChapters: 2 })
		const projectId = chain.projectId
		const outline = chain.routes.outline
		read = new Database(path.join(directory, 'workspace.sqlite'), { readonly: true })
		const seededRow = planRow(read, projectId)
		assert.equal(seededRow.version, 1, '链路只保存一版骨架章纲')

		// 1. 预览按组折算，且不发送任何内容。
		const preview = await call(outline, { plannedChapters: planned })
		assert.equal(preview.dryRun, true)
		assert.equal(preview.groups, 3, `${planned} 章应折算成 3 次调用`)
		assert.match(preview.prompt.user.instructions, new RegExp(`本次只输出第 1 至 ${groupSize} 章`))
		assert.equal(groupCalls().length, 0, '预览不得发送模型请求')
		const noConsent = await call(outline, { action: 'generate-group', plannedChapters: planned, from: 1 }, 400)
		assert.match(noConsent.error, /外发/)
		assert.equal(groupCalls().length, 0, '未确认外发时零请求')
		await call(outline, { action: 'generate-group', plannedChapters: planned, from: 0, allowExternalTransfer: true }, 400)
		await call(outline, { plannedChapters: 1001 }, 400)

		// 2. 第一组只交 10 章，且编号按全书位置给出；规划仍未落库。
		const first = await call(outline, { action: 'generate-group', plannedChapters: planned, from: 1, accumulated: [], allowExternalTransfer: true })
		assert.equal(first.chapters.length, groupSize)
		assert.equal(first.from, 1)
		assert.equal(first.to, groupSize)
		assert.equal(first.groups, 3)
		assert.equal(first.generated, groupSize)
		assert.equal(first.plan, undefined, '未凑满计划章数时不返回可保存的整本规划')
		assert.deepEqual(
			first.chapters.map((item) => item.id),
			Array.from({ length: groupSize }, (_, index) => `chapter-${String(index + 1).padStart(2, '0')}`),
			'第一组编号须连续'
		)
		const firstLog = groupCalls().at(-1)
		assert.equal(firstLog.generatedBefore, 0)
		assert.equal(firstLog.previousChapter, null, '第一组没有前章可衔接')
		assert.equal(firstLog.bookTitle, null)
		assert.equal(firstLog.maxTokens, 1000 + 1100 * groupSize, '输出预算按本组章数折算')
		assert.equal(planRow(read, projectId).version, 1, '逐组生成过程中不得写入规划')

		// 3. 第二组带着第一组末章的钩子与整本设定；书名以第一组为准。
		const second = await call(outline, {
			action: 'generate-group',
			plannedChapters: planned,
			from: groupSize + 1,
			accumulated: first.chapters,
			book: first.book,
			allowExternalTransfer: true,
		})
		assert.equal(second.chapters.length, groupSize)
		assert.deepEqual(
			second.chapters.map((item) => item.id),
			Array.from({ length: groupSize }, (_, index) => `chapter-${String(groupSize + index + 1).padStart(2, '0')}`),
			'后续组必须按全书位置重编号，不能沿用模型的相对编号'
		)
		const secondLog = groupCalls().at(-1)
		assert.equal(secondLog.generatedBefore, groupSize)
		assert.equal(secondLog.previousChapter.id, `chapter-${String(groupSize).padStart(2, '0')}`)
		assert.equal(secondLog.previousChapter.endingHook, first.chapters.at(-1).endingHook, '请求要带上上一组末章的钩子')
		assert.equal(secondLog.bookTitle, first.book.title, '后续组回传第一组的整本设定')
		assert.equal(second.book.title, first.book.title, '整本书名以第一组为准，不随每组调用改变')

		// 4. 中途上游失败：报「未写入任何规划」，已生成章节由界面留在浏览器里，版本不动。
		writeFileSync(failFlag, 'fail')
		const broken = await call(
			outline,
			{ action: 'generate-group', plannedChapters: planned, from: groupSize * 2 + 1, accumulated: [...first.chapters, ...second.chapters], book: first.book, allowExternalTransfer: true },
			502
		)
		rmSync(failFlag)
		assert.match(broken.error, /未写入任何规划/)
		assert.equal(groupCalls().length, 2, '失败的调用不产出章节')
		assert.equal(planRow(read, projectId).version, 1, '上游失败同样不落库')

		// 5. 停笔成稿：只有 20 章时也按已有章节合并，交给作者确认后再保存。
		const partial = await call(outline, { action: 'finalize', plannedChapters: planned, accumulated: [...first.chapters, ...second.chapters], book: first.book })
		assert.equal(partial.plan.chapters.length, groupSize * 2)
		assert.equal(partial.accepted, true, JSON.stringify(partial.issues))
		assert.equal(partial.groups, 3)
		assert.equal(planRow(read, projectId).version, 1, '成稿只是草稿，保存前不落库')
		const noFrame = await call(outline, { action: 'finalize', plannedChapters: planned, accumulated: first.chapters }, 400)
		assert.match(noFrame.error, /缺少第一组/)
		const emptyRun = await call(outline, { action: 'finalize', plannedChapters: planned, accumulated: [], book: first.book }, 409)
		assert.match(emptyRun.error, /还没有任何已生成/)

		// 6. 补齐第三组：凑满计划章数即返回整本规划，编号连续且零落库。
		const last = await call(
			outline,
			{ action: 'generate-group', plannedChapters: planned, from: groupSize * 2 + 1, accumulated: [...first.chapters, ...second.chapters], book: first.book, allowExternalTransfer: true }
		)
		assert.equal(last.chapters, undefined, '最后一组直接返回整本规划')
		assert.equal(last.generated, planned)
		assert.equal(last.groups, 3)
		assert.deepEqual(last.lastGroup, { from: groupSize * 2 + 1, to: planned, chapters: planned - groupSize * 2 })
		assert.equal(last.plan.chapters.length, planned)
		assert.deepEqual(
			last.plan.chapters.map((item) => item.id),
			Array.from({ length: planned }, (_, index) => `chapter-${String(index + 1).padStart(2, '0')}`),
			'合并后的编号必须覆盖全书且连续'
		)
		assert.equal(last.plan.scope.plannedChapters, planned)
		assert.equal(last.accepted, true, JSON.stringify(last.issues))
		// 每组只回显本组调用的用量与预算；整本合计由界面逐组累加后展示。
		assert.deepEqual(
			{ promptTokens: last.usage.promptTokens, completionTokens: last.usage.completionTokens },
			{ promptTokens: 800, completionTokens: 400 },
			'最后一组只带本次调用的用量'
		)
		assert.equal(last.estimate.maxOutputTokens, 1000 + 1100 * (planned - groupSize * 2), '输出预算按本组章数折算')
		assert.equal(groupCalls().length, 3, `${planned} 章正好三次调用`)
		assert.equal(planRow(read, projectId).version, 1, '未保存的整本规划不落库')

		// 7. 作者确认后保存：25 章通过结构校验并产生新版本；超出兜底上限仍被拒。
		const saved = await call(outline, { expectedVersion: seededRow.version, plan: last.plan }, 200, 'PUT')
		assert.equal(saved.version, 2)
		assert.equal(JSON.parse(planRow(read, projectId).planJson).chapters.length, planned, '全书 25 章落库')
		assert.equal(planRow(read, projectId).version, 2)
		const oversized = structuredClone(last.plan)
		oversized.chapters = Array.from({ length: 1001 }, (_, index) => ({ ...last.plan.chapters[0], id: `chapter-${String(index + 1).padStart(4, '0')}` }))
		await call(outline, { expectedVersion: 2, plan: oversized }, 400, 'PUT')
		assert.equal(planRow(read, projectId).version, 2, '超上限的保存不得改动规划')

		console.log(
			`PASS: outline grouping — ${planned} 章折算 3 次调用、每次最多 ${groupSize} 章、跨组带上一组末章钩子与整本设定、全书编号连续、上游失败与停笔成稿均零落库、保存后 25 章通过校验且 1001 章被拒；provider network replaced by fixture.`,
		)
	} catch (error) {
		console.error(logs)
		throw error
	} finally {
		await stop()
		read?.close()
		if (!seeded) rmSync(directory, { recursive: true, force: true })
	}
}
