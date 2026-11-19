// 品性线索抽取：从带年纪事的原文里找出「能体现人物性格与精神风貌」的用语，零 Token、可回溯到原句。
// 史料里的品性要么被史家直接评述（性仁恕、明達有度量），要么落在具体言行上（固辭、單騎、醉酒、切諫）；
// 两者都不等于作者已核定，界面一律标「线索，待核」，命中词与原句片段一并带出以便人工比对。
// CLI 调参脚本（npm run cues:tune）与 Next 服务共用本文件，因此保持纯 ES module、不读数据库、不依赖 TypeScript。

// 校勘与补文标记：〔…〕与 [..] 是整理者加的校记，不是正文，先剥掉再判线索，否则人名与书名会冒充品性词。
const NOISE = /〔[^〕]*〕|\[[^\]]*\]|（[^）]*）/g

export const CUE_KINDS = [
	{
		kind: '胆略',
		words: ['單騎', '先登', '陷陣', '陷陳', '手殺', '大呼', '奮擊', '馳擊', '冒刃', '犯鋒', '彎弓', '百步', '勇冠', '挺身', '拔劍', '按劍', '獨前', '突圍', '輕敵'],
	},
	{
		kind: '沉毅',
		words: ['雅量', '不驚', '默然', '閉壘', '堅壁', '按兵', '固守', '鎮之', '徐曰', '處之', '不為動', '沉果', '持重', '深沉'],
	},
	{
		kind: '忠烈',
		words: ['死戰', '罵曰', '罵詈', '不降', '義不', '殉', '拒命', '斬使', '伏闕', '守節', '臨危', '請死', '以死', '死之'],
	},
	{
		kind: '仁厚',
		words: ['仁恕', '不忍', '恤', '賑', '省刑', '輕賦', '寬恕', '得眾心', '愛民', '撫恤', '惻然', '收骸骨', '止殺', '泣'],
	},
	{
		kind: '机断',
		words: ['反間', '設伏', '詐', '偽', '密謀', '因勢', '決斷', '決策', '權變', '間行', '邀擊', '先發'],
	},
	{
		kind: '刚直',
		words: ['切諫', '極諫', '面折', '力爭', '抗表', '忤旨', '諫曰', '剛直', '質直', '方正', '正色', '犯顏', '劾', '獨吊'],
	},
	{
		kind: '恭俭',
		words: ['固辭', '謙讓', '辭讓', '讓位', '讓國', '固讓', '克己', '恭儉', '節儉', '蔬食', '布衣', '手不釋卷', '好學', '辭位', '不名一錢'],
	},
	{
		kind: '骄忿',
		words: ['盛怒', '大怒', '怒曰', '怒謂', '恚怒', '數讓', '責讓', '讓之曰', '醉', '酣', '僭', '驕', '淫', '奢', '殘忍', '嚴酷', '誅戮', '濫刑', '恃功', '不度', '屠城', '坑之', '夷三族'],
	},
	{
		kind: '才情',
		words: ['屬文', '賦詩', '清談', '嘯詠', '善書', '美姿貌', '風神', '音吐', '有文武才', '博覽', '辯士', '應答如響', '下筆', '善談'],
	},
]

// 史家直接评述品性的句式：命中即最高档，因为它就是人物性格的史料依据。
// 一律优先两字以上的固定搭配，单个「性／少／器」在编年记事里太常见，会把除拜灾异也提成有戏。
const TRAIT_WORDS = [
	'有度量',
	'明達',
	'器度',
	'大器',
	'宏雅',
	'弘雅',
	'寬厚',
	'寬仁',
	'謹慎',
	'厚重',
	'果毅',
	'剛毅',
	'沉毅',
	'忠謹',
	'貞烈',
	'孝友',
	'輕財',
	'禮士',
	'好士',
	'多疑',
	'寡慾',
	'有威',
	'嚴整',
	'有志行',
	'少好學',
	'有大志',
	'喜怒不形',
	'性仁',
	'性孝',
	'性儉',
	'性急',
	'性剛',
	'性殘',
	'性寬',
	'其性',
]

// 事务性记事：除拜、册封、赠谥、灾异与历法，本身不体现性格，默认降权折叠。
const ADMINISTRATIVE = ['同平章事', '節度使', '刺史', '贈', '謚', '大赦', '改元', '皇后', '冊', '進位', '單于', '日食', '地震', '旱', '蝗', '星', '祠', '貢']

// 行动性记事：战政、外交与狱讼，有戏但需要作者自己补出性格表现。
const ACTION_WORDS = ['擊', '攻', '斬', '討', '誅', '圍', '奔', '敗', '擒', '戰', '立', '廢', '弑', '篡', '執', '虜', '克', '陷', '平', '救', '殺', '反', '盟', '叛', '聘', '貳']

/** 剥掉校记与括注，只留正文参与判定。 */
export function plainText(text) {
	return String(text ?? '').replace(NOISE, ' ')
}

/** 整理者加的校记、补文与考证条，不是史料记事本身。 */
export function isEditorialNote(text) {
	const source = String(text ?? '')
	return source.trimStart().startsWith('↑') || /司馬光避宋諱|考訂|輯証|校記/.test(source)
}

/** 取命中词所在的一句（按句读断开），供界面直接展示可核对的上下文。 */
function sentenceAround(source, index, length) {
	const breaks = ['。', '；', '！', '？', '：', '，', '、']
	let start = 0
	for (let cursor = index - 1; cursor >= 0 && cursor >= index - 40; cursor -= 1) {
		if (breaks.includes(source[cursor])) {
			start = cursor + 1
			break
		}
	}
	let stop = source.length
	for (let cursor = index + length; cursor < source.length && cursor <= index + length + 52; cursor += 1) {
		if (breaks.includes(source[cursor])) {
			stop = cursor + 1
			break
		}
	}
	return source.slice(start, stop).trim().slice(0, 120)
}

function scan(source, words) {
	for (const word of words) {
		const index = source.indexOf(word)
		if (index >= 0) return { word, span: sentenceAround(source, index, word.length) }
	}
	return null
}

/**
 * 一条记事的品性线索与戏剧价值分层。
 * tier 1＝史家品性评述或性格化言行命中（值得写成戏）；tier 2＝战政行动；tier 3＝除拜赠谥灾异等事务性记事。
 * 校记与补文单列 tier 0，列表默认不显示。
 */
export function detectCues(text) {
	if (isEditorialNote(text)) return { cues: [], tier: 0 }
	const source = plainText(text)
	if (!source.trim()) return { cues: [], tier: 0 }
	const cues = []
	const trait = scan(source, TRAIT_WORDS)
	if (trait) cues.push({ kind: '品性评述', word: trait.word, span: trait.span })
	for (const group of CUE_KINDS) {
		const hit = scan(source, group.words)
		if (hit && !cues.some((cue) => cue.word === hit.word)) cues.push({ kind: group.kind, word: hit.word, span: hit.span })
		if (cues.length >= 4) break
	}
	if (cues.length) return { cues: cues.slice(0, 4), tier: 1 }
	if (scan(source, ACTION_WORDS)) return { cues: [], tier: 2 }
	return { cues: [], tier: scan(source, ADMINISTRATIVE) ? 3 : 2 }
}
