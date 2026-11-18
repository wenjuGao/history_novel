// 年纪锚点解析的单元测试：不建项目、不发请求、不调模型。
// 设置 HISTORY_DATA_DIR 时额外对隔离目录里已索引的语料做只读抽查，证明记事能回到卷原文。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
	birthFromAge,
	buildNameIndex,
	buildProfile,
	clipText,
	coreInterval,
	deathMarkerAt,
	ganzhiOf,
	indexVolume,
	parseChineseYear,
	parseYearHeading,
} from '../src/lib/corpus-years.mjs'

// 1. 中文纪年数字：逐位、十进制与两种「零」都要能解析，非数字必须拒绝。
assert.equal(parseChineseYear('一一六'), 116)
assert.equal(parseChineseYear('三六八'), 368)
assert.equal(parseChineseYear('三十五'), 35)
assert.equal(parseChineseYear('三百零七'), 307)
assert.equal(parseChineseYear('三百〇七'), 307)
assert.equal(parseChineseYear('元初三年'), null, '混入非数字要拒绝')

// 2. 年纪标题：公元／西元／公元前、嵌套括号都要认；公元前存天文纪年负值；干支只作软校验。
assert.deepEqual(parseYearHeading('孝安皇帝元初三年（丙辰，公元一一六年）'), {
	year: 116,
	label: '孝安皇帝元初三年（丙辰，公元一一六年）',
	ganzhi: '丙辰',
	ganzhiMatches: ganzhiOf(116) === '丙辰',
})
assert.equal(parseYearHeading('顯王元年〈癸丑，西元前三六八年〉').year, -367, '公元前 368 年＝天文纪年 -367')
assert.equal(parseYearHeading('威烈王二十三年〈（壬辰，公元前四〇三年）〉').year, -402, '嵌套括号与「公元前」都要命中')
assert.equal(parseYearHeading('襄王元年〈（庚寅，後漢九二三年）〉'), null, '只用朝代年号「後漢九二三」不构成绝对纪年')
assert.equal(parseYearHeading('襄王元年〈（庚寅，後漢西元九二三年）〉').year, 923, '带「西元」的绝对纪年以公元数为准')
assert.equal(parseYearHeading(`威烈王二十三年${'甲'.repeat(60)}（辛未，公元前四〇三年）`), null, '超过 60 字的行不当作年纪锚点')
assert.equal(parseYearHeading('孝安皇帝永初三年（庚寅，公元一一九年）').ganzhiMatches, false, '干支与公元数不一致要标出来，仍以公元数为准')

// 3. 死亡标记：只认「人名＋少量虚字＋死亡词」的主语句式，追述、旁人死、非人物崩卒都不算。
assert.equal(deathMarkerAt('曹操病卒于洛陽', 2)?.marker, '卒')
assert.equal(deathMarkerAt('諸葛亮卒于五丈原', 3)?.marker, '卒')
assert.equal(deathMarkerAt('曹操當死數矣', 2), null, '裸「死」不作标记，避免「當死」「不死」误判')
assert.equal(deathMarkerAt('聞孫策死于江東', 3), null, '「聞…死」是追述他人')
assert.equal(deathMarkerAt('山崩地裂', 0), null, '山崩不是人物死亡')
assert.equal(deathMarkerAt('士卒崩壞', 2), null, '士卒的「卒」与崩壞都不是死亡')
assert.equal(deathMarkerAt('曹操誅之', 2), null, '「誅之」的对象是别人，不是本人死亡')

// 4. 年龄记注只能推近似生年，没有年龄就不编造。
assert.equal(birthFromAge('諸葛亮年十七歲', 3, 190), 174)
assert.equal(birthFromAge('諸葛亮少時人莫之異也', 3, 190), null)

// 5. 活动区间：后世追述要被修剪，记事稀疏时不能塌成一年。
const trimmed = coreInterval([184, 189, 192, 196, 200, 204, 208, 213, 216, 220, 280, 417], { window: 30 })
assert.ok(trimmed.start >= 184 && trimmed.end <= 220, `种子窗口之外应视为追述：${JSON.stringify(trimmed)}`)
assert.equal(trimmed.trimmed, true)
assert.deepEqual(coreInterval([184, 200, 216]), { start: 184, end: 216, outside: 0, trimmed: false }, '记事太少时不修剪，交人工核对')

// 6. 卷内定年：标题之下的记事带绝对年份，卷末纪年带给下一卷；截断只落在句读处。
const volumeText = ['威烈王二十三年〈（壬辰，公元前四〇三年）〉', '初命晉大夫魏斯、趙籍、韓虔為諸侯。', '（甲辰，公元前四〇七年）', '子夏之晉，過衛。'].join('\n')
const parsedVolume = indexVolume(volumeText, buildNameIndex(['子夏', '魏斯']), { carryYear: -410, carryLabel: '承接前卷' })
assert.equal(parsedVolume.entries.length, 2)
assert.equal(parsedVolume.entries[0].year, -402)
assert.deepEqual(parsedVolume.entries[0].names, ['魏斯'])
assert.equal(parsedVolume.entries[1].year, -406)
assert.equal(parsedVolume.carryYear, -406, '卷末纪年要带给下一卷')
const longText = `${'漢初天下未定'.repeat(5)}，${'乙'.repeat(80)}。`
assert.equal(clipText(longText, 60), longText.slice(0, 31), '截断必须停在句读处，保证仍是原文子串')

// 7. 人物年份档案：卒年把活动区间收住，追述单列，事迹带回出处卷。
const profile = buildProfile(
	'諸葛亮',
	[
		{ year: 200, yearPrecision: 'exact', text: '諸葛亮居襄陽，好為《管晏》。', names: ['諸葛亮'], deaths: [], volumeName: '卷六十二', sourceUrl: 'u' },
		{ year: 207, yearPrecision: 'exact', text: '諸葛亮字孔明，琅琊人。', names: ['諸葛亮'], deaths: [], volumeName: '卷六十五', sourceUrl: 'u' },
		{ year: 225, yearPrecision: 'exact', text: '諸葛亮南征，七擒七縱。', names: ['諸葛亮'], deaths: [], volumeName: '卷七十', sourceUrl: 'u' },
		{ year: 234, yearPrecision: 'exact', text: '諸葛亮卒于軍，後主斂髮殤之。', names: ['諸葛亮'], deaths: [{ name: '諸葛亮', marker: '卒' }], volumeName: '卷七十三', sourceUrl: 'u' },
		{ year: 904, yearPrecision: 'exact', text: '人談諸葛亮之忠。', names: ['諸葛亮'], deaths: [], volumeName: '卷二六五', sourceUrl: 'u' },
	],
	{ deedsLimit: 5 }
)
assert.equal(profile.death, 234)
assert.equal(profile.lastYear, 234, '卒年之后的记事只能是追述，活动区间不得晚于卒年')
assert.equal(profile.firstYear, 200)
assert.equal(profile.laterMentions, 1)
assert.equal(profile.birth, null, '没有「年若干歲」时生年留空，不用活动年份代填')
assert.equal(profile.deeds.length, 4)
assert.ok(profile.deeds.every((deed) => deed.year >= 200 && deed.year <= 234), '事迹只取活动区间内的记事')
assert.ok(profile.deeds.every((deed) => deed.volume), '事迹必须带回可核对的出处卷')

// 8. 只读抽查：记事能在对应卷文本里定位，否则写事件时证据校验必然失败。
const dataDir = process.env.HISTORY_DATA_DIR?.trim()
if (dataDir && existsSync(path.join(dataDir, 'workspace.sqlite'))) {
	const database = new Database(path.join(dataDir, 'workspace.sqlite'), { readonly: true })
	const state = database.prepare("SELECT rows FROM corpus_state WHERE kind = 'years'").get()
	assert.ok(state && state.rows > 0, 'corpus_state(kind=years) 为空，请先执行 npm run corpus:years')
	const orphan = database
		.prepare(
			`SELECT COUNT(*) AS count FROM corpus_entry e
			 WHERE NOT EXISTS (SELECT 1 FROM corpus_volume v WHERE v.book_id = e.book_id AND v.volume_name = e.volume_name AND instr(v.text, e.text) > 0)`,
		)
		.get().count
	assert.equal(orphan, 0, '存在回不到卷原文的记事')
	assert.equal(database.prepare('SELECT MIN(year_astronomical) AS year FROM corpus_entry').get().year, -402, '资治通鉴始于公元前 403 年')
	const profiles = database.prepare('SELECT COUNT(*) AS count FROM corpus_person_profile').get().count
	const wide = database.prepare('SELECT COUNT(*) AS count FROM corpus_person_profile WHERE last_year - first_year > 60').get().count
	assert.ok(wide * 10 < profiles, `活动区间超过 60 年的档案占比过高（${wide}/${profiles}），多半没修剪追述`)
	database.close()
	console.log('已抽查隔离目录语料：记事可回到原文、年纪区间已修剪。')
} else {
	console.log('未设置 HISTORY_DATA_DIR，跳过语料抽查（只跑解析单测）。')
}

console.log('PASS: 年纪标题解析、干支软校验、死亡标记、活动区间修剪、人物年份档案与原文可回溯性。')
