import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { CUE_KINDS, detectCues } from '../src/lib/corpus-character-cues.mjs'

// 品性线索词库调参：扫描本机带年纪事，输出分层占比、各类命中率、逐词命中率与样例，
// 用来判断词库是拍脑袋还是真命中。只读语料，不写库、不调模型。
// 用法：node scripts/tune-character-cues.mjs [--from 900] [--to 960] [--samples 3]

const args = process.argv.slice(2)
const read = (name, fallback) => {
	const index = args.indexOf(`--${name}`)
	return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const wantedSamples = read('samples', 3)
const fromYear = read('from', Number.NaN)
const toYear = read('to', Number.NaN)

const database = new Database(path.join(process.env.HISTORY_DATA_DIR ?? 'data/local', 'workspace.sqlite'), { readonly: true })
const rows = database
	.prepare('SELECT year_astronomical AS year, text FROM corpus_entry ORDER BY year_astronomical, sequence')
	.all()
	.filter((row) => (Number.isNaN(fromYear) || row.year >= fromYear) && (Number.isNaN(toYear) || row.year <= toYear))
assert.ok(rows.length, '语料里没有落在该时间区间的记事，请先执行 npm run corpus:index 与 npm run corpus:years')

const tierNames = { 0: '校记补文', 1: '有品性线索', 2: '行动记事', 3: '事务性记事' }
const tiers = { 0: 0, 1: 0, 2: 0, 3: 0 }
const kinds = new Map()
const words = new Map()
const samples = new Map()
for (const row of rows) {
	const found = detectCues(row.text)
	tiers[found.tier] += 1
	for (const cue of found.cues) {
		kinds.set(cue.kind, (kinds.get(cue.kind) ?? 0) + 1)
		words.set(`${cue.kind}/${cue.word}`, (words.get(`${cue.kind}/${cue.word}`) ?? 0) + 1)
		if (!((samples.get(cue.kind)?.length ?? 0) >= wantedSamples)) {
			samples.set(cue.kind, [...(samples.get(cue.kind) ?? []), `${row.year} ${cue.word}｜${cue.span}`])
		}
	}
}

console.log(`样本 ${rows.length} 条记事${Number.isNaN(fromYear) ? '' : `（${fromYear}—${toYear} 年）`}`)
console.log('分层占比：', Object.entries(tiers).map(([tier, count]) => `${tier}·${tierNames[tier]} ${count}（${((100 * count) / rows.length).toFixed(1)}%）`).join('　'))
console.log('\n各类命中：')
for (const group of [{ kind: '品性评述' }, ...CUE_KINDS]) {
	const count = kinds.get(group.kind) ?? 0
	console.log(`  ${group.kind.padEnd(5)} ${String(count).padStart(5)}  ${((100 * count) / rows.length).toFixed(1)}%`)
}
console.log('\n逐词命中（升序，末位为可疑的空词或误命中）：')
const ranked = [...words.entries()].sort((a, b) => a[1] - b[1])
for (const [label, count] of ranked.slice(0, 14)) console.log(`  ${label.padEnd(16)} ${count}`)
console.log('  …')
for (const [label, count] of ranked.slice(-8)) console.log(`  ${label.padEnd(16)} ${count}`)
console.log('\n样例：')
for (const [kind, list] of samples) {
	console.log(`  【${kind}】`)
	for (const line of list) console.log(`    ${line.slice(0, 110)}`)
}
