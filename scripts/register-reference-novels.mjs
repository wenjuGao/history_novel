import { registerReferenceNovels } from '../src/lib/reference-novels.mjs'
import { openDatabase } from './lib/db.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--help')) {
	console.log('用法：npm run refs:register —— 校验本机已转换参考小说并登记哈希与抽象写作规格。')
	process.exit(0)
}

const root = process.cwd()
const started = Date.now()
const { database } = openDatabase()
const summary = await registerReferenceNovels(database, {
	root,
	onVolume: (volume) => {
		if (volume.status === 'ok') console.log(`${volume.series} ${volume.volume}　${volume.characters.toLocaleString('zh-CN')} 字　已校验`)
		else console.log(`${volume.series} ${volume.volume}　${volume.status === 'missing' ? '缺少转换产物' : (volume.problems ?? []).join('；')}`)
	},
})

for (const spec of summary.specs) {
	console.log(`写作规格 ${spec.seriesKey}　方法 ${spec.methods.length} 类：${spec.methods.join('、')}`)
	console.log(`　组合哈希 ${spec.combinedSha256.slice(0, 16)}…　规格哈希 ${spec.specSha256.slice(0, 16)}…`)
}
for (const missing of summary.missing) console.log(`警告：${missing}`)
console.log(`完成：${summary.series} 个系列 / ${summary.verified} 卷已登记，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`)
if (summary.missing.length) process.exitCode = 1
