// 以事件为主的第一版回归：史料记事候选、逐条核对门禁、批量采用、人名去重带出人物、性格与风貌配置、外发门禁与模型稿落库。
// 必须在 HISTORY_DATA_DIR 隔离目录上运行（脚本自造一本测试史书，不依赖真实语料索引）。
// 未设置 TEST_BASE_URL 时脚本自己起一台挂了假模型端点的服务，模型请求全部由本机拦截，不外呼真实百炼。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dataDir = process.env.HISTORY_DATA_DIR
if (!dataDir) {
	console.error('必须设置 HISTORY_DATA_DIR 指向隔离数据目录，避免把测试数据写进真实工作区。')
	process.exit(1)
}

const requestLog = path.join(os.tmpdir(), `event-first-requests-${process.pid}.log`)
const port = Number(process.env.TEST_PORT ?? 3117)
let baseUrl = process.env.TEST_BASE_URL
let server

async function startFixtureServer() {
	baseUrl = `http://127.0.0.1:${port}`
	server = spawn(
		process.execPath,
		[
			'--import',
			fileURLToPath(new URL('./lib/fake-profile-provider.mjs', import.meta.url)),
			'node_modules/next/dist/bin/next',
			'dev',
			'--hostname',
			'127.0.0.1',
			'--port',
			String(port),
		],
		{
			cwd: process.cwd(),
			detached: true,
			env: {
				...process.env,
				HISTORY_TEST_BUILD: '1',
				HISTORY_DATA_DIR: dataDir,
				EVENT_FIRST_FIXTURE: '1',
				EVENT_FIRST_REQUEST_LOG: requestLog,
				DASHSCOPE_API_KEY: 'fixture-only',
				BAILIAN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
				NEXT_TELEMETRY_DISABLED: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	)
	let logs = ''
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error(`假模型服务启动超时：${logs}`)), 120000)
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
			reject(new Error(`假模型服务提前退出：${code}\n${logs}`))
		})
	})
}

function fixtureRequests() {
	if (server === undefined || !existsSync(requestLog)) return null
	return readFileSync(requestLog, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}

if (!baseUrl) await startFixtureServer()
const base = baseUrl

let database

async function openDatabase() {
	database = new Database(path.join(dataDir, 'workspace.sqlite'))
	database.pragma('foreign_keys = ON')
	database.pragma('busy_timeout = 5000')
}

function hasTable(name) {
	return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

const bookId = 'test-event-first'
const volumeName = '卷第一'
const now = new Date().toISOString()

// 三条记事：一条史家直接评述品性（tier 1）、一条行动记事（tier 2）、一条除拜事务（tier 3，默认折叠）。
// 共享人名「李文」跨事件出现，用来验证去重带出。
const entries = [
	{ key: 'e1', year: 801, label: '元年', text: '李文性仁恕，單騎入壘，謂眾曰：「止殺，吾不忍也。」', names: ['李文', '張某'] },
	{ key: 'e2', year: 802, label: '二年', text: '二年，李文與賊戰于野，切諫，軍遂還。', names: ['李文'] },
	{ key: 'e3', year: 803, label: '三年', text: '三年三月，以王某為河東道節度使，贈太保。', names: ['王某'] },
]
const volumeText = entries.map((entry) => entry.text).join('\n')

async function call(route, body, expected = 200, method) {
	const isGet = body === undefined
	const response = await fetch(`${base}${route}`, {
		method: isGet ? 'GET' : method ?? 'POST',
		headers: { origin: base, 'content-type': 'application/json' },
		body: isGet ? undefined : JSON.stringify(body),
	})
	const raw = await response.text()
	let data
	try {
		data = raw ? JSON.parse(raw) : {}
	} catch {
		assert.fail(`${route} -> HTTP ${response.status} 非 JSON 响应：${raw.slice(0, 400)}`)
	}
	assert.equal(response.status, expected, `${route} -> ${JSON.stringify(data)}`)
	return data
}

function seedCorpus() {
	database.exec('PRAGMA foreign_keys = OFF')
	database
		.prepare(
			`INSERT OR REPLACE INTO corpus_book(book_id, name, title, category, start_year, end_year, coverage_precision, volume_count, page_count, complete, report_sha256, indexed_at)
			 VALUES (?, ?, ?, '正史', 800, 810, 'exact', 1, 1, 1, '', ?)`,
		)
		.run(bookId, '測試事件優先書', '測試事件優先書', now)
	database
		.prepare(
			`INSERT OR REPLACE INTO corpus_volume(book_id, volume_name, page_key, source_url, oldid, text, text_length, text_sha256, collected_at, indexed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(bookId, volumeName, 'p1', `${base}/test`, '1', volumeText, [...volumeText].length, createHash('sha256').update(volumeText).digest('hex'), now, now)
	for (const entry of entries) {
		database
			.prepare(
				`INSERT OR REPLACE INTO corpus_entry(entry_key, book_id, volume_name, year_astronomical, year_label, sequence, period, text, has_death, year_precision, source_url, indexed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?)`,
			)
			.run(entry.key, bookId, volumeName, entry.year, entry.label, Number(entry.key.slice(1)), '唐', entry.text, 0, `${base}/test`, now)
		database.prepare('DELETE FROM corpus_entry_person WHERE entry_key = ?').run(entry.key)
		for (const name of entry.names) database.prepare('INSERT INTO corpus_entry_person(entry_key, name, is_death) VALUES (?, ?, 0)').run(entry.key, name)
	}
	database.prepare('INSERT OR REPLACE INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES (?, ?, ?, ?, ?)').run('years', '', 3, now, 'test-event-first')
	database.prepare('INSERT OR REPLACE INTO corpus_state(kind, sha256, rows, built_at, notes) VALUES (?, ?, ?, ?, ?)').run('corpus', '', 1, now, 'test-event-first')
	database.exec('PRAGMA foreign_keys = ON')
}

function clearCorpus() {
	database.prepare('DELETE FROM corpus_entry_person WHERE entry_key IN (SELECT entry_key FROM corpus_entry WHERE book_id = ?)').run(bookId)
	database.prepare('DELETE FROM corpus_entry WHERE book_id = ?').run(bookId)
	database.prepare('DELETE FROM corpus_volume WHERE book_id = ?').run(bookId)
	database.prepare('DELETE FROM corpus_book WHERE book_id = ?').run(bookId)
}

let projectId
let failure

try {
	// 先打一次接口，让服务端把隔离库的表结构建好，脚本再直接写测试语料。
	await call('/api/projects')
	await openDatabase()
	seedCorpus()
	const project = await call('/api/projects', { name: `以事件為主測試-${Date.now()}` }, 201)
	projectId = project.project.id

	// 1. 第 01 步定下时间阶段后，第 03 步按年代列出记事；事务性记事默认折叠，品性线索分档带出。
	await call('/api/projects/' + projectId + '/scope', { startYear: 800, endYear: 810, region: '唐' }, 200, 'PUT')
	const stage = await call(`/api/projects/${projectId}/events/candidates?start=800&end=810`)
	assert.equal(stage.ready, true, stage.note)
	assert.ok(stage.candidates.some((item) => item.key === 'corpus:e1'), '测试记事要出现在候选里')
	assert.ok(!stage.candidates.some((item) => item.key === 'corpus:e3'), `默认应折叠事务性记事：${JSON.stringify(stage.candidates.map((item) => item.key))}`)
	const first = stage.candidates.find((item) => item.key === 'corpus:e1')
	assert.ok(first, '缺少品性评述记事')
	assert.equal(first.tier, 1)
	assert.ok(first.cues.length >= 2, '应抽出多条品性线索')
	assert.deepEqual([...first.names].sort(), ['張某', '李文'].sort(), '候选要带出记事里的人名')
	const admin = await call(`/api/projects/${projectId}/events/candidates?start=800&end=810&administrative=1`)
	assert.ok(admin.candidates.some((item) => item.key === 'corpus:e3'), '显式要求时才显示除拜记事')
	assert.equal(admin.candidates.find((item) => item.key === 'corpus:e3').tier, 3)

	// 2. 采用前预览：跨记事按人名去重，并标出还需要新建的人。
	const preview = await call(`/api/projects/${projectId}/events/persons?keys=corpus:e1,corpus:e2`)
	assert.equal(preview.persons.length, 2, `两个人名跨记事去重：${JSON.stringify(preview.persons)}`)
	const broughtLi = preview.persons.find((person) => person.name === '李文')
	assert.equal(broughtLi.eventCount, 2, '同一人参与两条记事只算一位人物')

	// 3. 多选批量采用：逐条要「已核对原文」，未核对的原样退回原因。
	const unconfirmed = await call(`/api/projects/${projectId}/events`, { action: 'adoptMany', items: [{ key: 'corpus:e1', confirmed: false }] }, 400)
	assert.match(unconfirmed.error, /没有记事被采用/)
	const adopted = await call(`/api/projects/${projectId}/events`, {
		action: 'adoptMany',
		items: [
			{ key: 'corpus:e1', confirmed: true, title: '仁恕止殺', cues: first.cues },
			{ key: 'corpus:e2', confirmed: true, cues: stage.candidates.find((item) => item.key === 'corpus:e2').cues },
			{ key: 'corpus:e3', confirmed: true },
			{ key: 'corpus:missing', confirmed: true },
		],
	})
	assert.equal(adopted.adoptedCount, 3)
	assert.deepEqual(adopted.skipped, [{ key: 'corpus:missing', reason: '本机史料里找不到这条记事' }])
	assert.equal(adopted.carryOver.created.filter((name) => name === '李文').length, 1, `李文只建一次：${JSON.stringify(adopted.carryOver)}`)
	const events = await call(`/api/projects/${projectId}/events`)
	assert.equal(events.events.length, 3)
	const eventOne = events.events.find((event) => event.title === '仁恕止殺')
	assert.equal(eventOne.evidence, entries[0].text, '证据必须是记事原文')
	assert.equal(eventOne.start, 801, '年代回读本机记事')
	assert.ok(eventOne.participants.some((person) => person.name === '李文'), '记事人名要挂成参与人物')
	assert.equal(events.events.find((event) => event.sourceKey === 'corpus:e2').title, '二年', '未改标题时沿用记事开头的建议标题')

	// 4. 重复采用同一记事要被拦下，避免事件与人物被写成两份。
	const again = await call(`/api/projects/${projectId}/events`, { action: 'adoptMany', items: [{ key: 'corpus:e1', confirmed: true }] }, 400)
	assert.match(again.error, /没有记事被采用：该记事已采用过/)

	// 5. 人物步骤（第 04 步）：事件带出的人物含参与事件与线索，性格与风貌由线索落底。
	const profiles = await call(`/api/projects/${projectId}/profiles`)
	const li = profiles.persons.find((person) => person.name === '李文')
	assert.ok(li, JSON.stringify(profiles.persons.map((person) => person.name)))
	assert.equal(li.events.length, 2)
	assert.ok(li.personality.includes('仁恕') || li.personality.includes('單騎'), `线索应落底为初稿：${li.personality}`)
	assert.equal(li.profileSource, '', '线索落底不算人工或模型稿')
	assert.equal(li.reviewStatus, 'auto')
	assert.equal(profiles.withoutProfile, 1, '王某还没有品性描述')
	assert.equal(profiles.allowExternalTransfer, false, '隔离数据目录不应默认同意外发')

	// 6. 外发门禁：未确认外发时拒绝生成，且不产生任何请求。
	const blocked = await call(`/api/projects/${projectId}/profiles`, { action: 'generate' }, 400)
	assert.match(blocked.error, /请先明确确认资料外发/)
	assert.deepEqual(fixtureRequests() ?? [], [], '门禁之前不应有模型请求')

	// 6.5 显式确认外发后由假端点生成：模型稿标为待核，编造姓名丢弃，每份稿子要么落库要么给出跳过原因。
	const generated = await call(`/api/projects/${projectId}/profiles`, { action: 'generate', allowExternalTransfer: true })
	assert.ok(generated.generated.length >= 2, JSON.stringify(generated.generated))
	assert.ok(!generated.generated.some((item) => item.name === '假稿不存在的人'), '模型编造的姓名不得进入结果')
	assert.equal(generated.saved.written + generated.saved.skipped.length, generated.generated.length, JSON.stringify(generated.saved))
	assert.equal(generated.usage?.promptTokens, 800)
	const afterGenerate = await call(`/api/projects/${projectId}/profiles`)
	const wang = afterGenerate.persons.find((person) => person.name === '王某')
	assert.equal(wang.profileSource, 'model', JSON.stringify(wang))
	assert.equal(wang.reviewStatus, 'auto')
	assert.match(wang.personality, /^假稿：由 \d+ 条记事归纳。$/)
	assert.ok(afterGenerate.preview.names.length >= 1 && afterGenerate.preview.characters > 0, '写操作后的响应要带上完整界面状态，人物页据此算预览用量')
	const requests = fixtureRequests()
	if (requests) {
		assert.equal(requests.length, 1, '一次生成只发一次请求')
		assert.deepEqual(requests[0].names, generated.generated.map((item) => item.name).slice(0, requests[0].names.length))
		assert.ok(requests[0].events.every((count) => count >= 1), '每位人物都要带上其记事')
	}

	// 7. 手写保存与核对确认：作者改过的文字来源转 manual，不再被模型稿覆盖。
	await call(`/api/projects/${projectId}/profiles`, { action: 'save', id: li.id, personality: '仁厚而能断', temperament: '臨陣不驚' })
	const saved = await call(`/api/projects/${projectId}/profiles`)
	const liSaved = saved.persons.find((person) => person.id === li.id)
	assert.equal(liSaved.personality, '仁厚而能断')
	assert.equal(liSaved.profileSource, 'manual')
	const previewed = await call(`/api/projects/${projectId}/profiles`, { action: 'preview' })
	assert.ok(previewed.names.includes('李文'), JSON.stringify(previewed.names))
	assert.ok(previewed.count >= 1 && previewed.characters > 0)
	await call(`/api/projects/${projectId}/profiles`, { action: 'confirm', id: saved.persons.find((person) => person.name === '王某').id })
	const confirmed = await call(`/api/projects/${projectId}/profiles`)
	assert.equal(confirmed.persons.find((person) => person.name === '王某').reviewStatus, 'confirmed')

	// 8. 事件变化会改写证据编号，提案绑定随之过期（REQ-050）。
	const hashAfter = (await call(`/api/projects/${projectId}/proposals`)).inputHash
	assert.ok(hashAfter && hashAfter.length >= 16, '提案输入哈希应可计算')

	console.log('以事件为主流程回归通过：候选筛选、核对门禁、批量采用、人名去重带出、性格风貌配置与外发门禁均符合预期。')
} catch (error) {
	failure = error
	throw error
} finally {
	if (projectId) {
		await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE', headers: { origin: base } }).catch(() => undefined)
		database?.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
	}
	if (database) {
		if (hasTable('corpus_entry')) clearCorpus()
		database.close()
	}
	if (server) {
		try {
			process.kill(-server.pid, 'SIGTERM')
		} catch {
			server.kill('SIGTERM')
		}
		await new Promise((resolve) => {
			server.once('exit', resolve)
			setTimeout(resolve, 5000)
		})
		rmSync(requestLog, { force: true })
	}
	if (failure) console.error(failure instanceof Error ? failure.message : failure)
}
