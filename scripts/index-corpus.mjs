import path from 'node:path'

import { indexCorpus } from '../src/lib/corpus-import.mjs'
import { openDatabase } from './lib/db.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback) => {
	const index = args.indexOf(`--${name}`)
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

if (flag('help')) {
	console.log('用法：npm run corpus:index [-- --corpus-root <目录>] [-- --data-dir <目录>]')
	console.log('把本机 Wikisource 快照写入 corpus_book/corpus_volume，重复执行只补齐变化的卷页。')
	process.exit(0)
}

const { database } = openDatabase()
const corpusRoot = path.resolve(valueOf('corpus-root', path.join(process.cwd(), 'data/local/corpus/wikisource')))
const started = Date.now()
console.log(`索引语料：${corpusRoot}`)
const summary = await indexCorpus(database, {
	corpusRoot,
	onBook: (book, volumes, delta) =>
		console.log(`  ${book.name.padEnd(6, '　')} ${String(volumes).padStart(4)} 卷  新增 ${delta.added} 更新 ${delta.updated} 未变 ${delta.unchanged}`),
})
console.log(
	`完成：${summary.books} 部 / ${summary.volumes} 卷 / ${summary.characters.toLocaleString()} 字符；新增 ${summary.added}、更新 ${summary.updated}、未变 ${summary.unchanged}，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`,
)
console.log(`报告哈希：${summary.reportSha256.slice(0, 16)}…`)
if (summary.missing.length) {
	for (const line of summary.missing) console.log(`缺失：${line}`)
	process.exitCode = 1
}
