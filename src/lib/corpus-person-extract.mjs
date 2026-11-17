// 史料人名的启发式抽取：古籍正文没有实体标注，只能靠「姓 + 1~2 字」再配合动作词判定候选。
// 结果一律标记为待确认（review_status='auto'），只作为项目配置的候选，不构成史实断言。

const surnameChars =
	'王李張劉陳楊趙黃周吳徐孫馬朱胡郭何高林羅鄭梁謝唐許韓馮鄧曹彭曾蕭田董袁潘于蔣蔡余杜葉程蘇魏呂丁任沈姚盧姜崔鐘譚陸范汪金石廖賈夏韋傅方白鄒孟熊秦邱江尹薛閻段雷侯龍史陶黎賀顧毛郝龔邵萬錢嚴武戴莫孔衛欧游關房戴牟虞封魯經貟酈荆聞'
const compoundSurnames = [
	'司馬', '司徒', '司空', '諸葛', '尉遲', '宇文', '慕容', '長孫', '歐陽', '令狐', '皇甫', '上官', '申屠', '公孫', '東郭', '南郭', '西門', '南宮', '東方', '百里', '呼延', '拓跋', '爾朱', '哥舒', '乞伏', '秃髮', '沮渠', '赫連', '鮮于', '仲長', '梁丘', '宰父', '穀梁', '胡母', '先且', '司空',
]

// 动作词表：候选前后出现这些字更像「某人在做某事」，而不是地名或官称。
const verbsAfter = ['曰', '言', '謂', '奏', '白', '遣', '命', '拜', '封', '誅', '殺', '圍', '攻', '奔', '降', '擊', '破', '帥', '率', '立', '廢', '讓', '守', '取', '敗', '追', '及', '聞', '使', '從', '將', '為', '與', '合', '拒', '戰', '反', '貶', '賜', '諫', '征', '伐', '質', '表', '購', '討', '斬', '囚', '竄', '薨', '卒', '死', '弑', '篡', '執', '下', '出', '入', '至', '屯', '行', '殺']
const verbsBefore = ['與', '遣', '命', '拜', '封', '誅', '殺', '圍', '攻', '奔', '降', '擊', '破', '帥', '率', '立', '廢', '讓', '聞', '使', '從', '謂', '曰', '詔', '表', '賜', '召', '征', '討', '斬', '執', '禽', '殺']

// 噪声字：抽取试验中绝大多数误命中都以这些字收尾（謚號、官稱、地理、軍號、句末虛詞）。
const badTailChars = '氏謚節度吾衞侍中令相將帥軍州郡府官兵民城池水食詔表奏書事變役禮樂刑賞罪虜敵衆旗鼓馬車船鎧甲弓矢刀劍印符璧金玉帛粟麥稻鹽鐵錢陵山川河江湖海野田園觀樓臺室屋門闕巷街路橋渡津關塞堡塢營屯廟寺佛僧尼天地日月星雲雨雪冰露春夏秋冬朔望甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥'
// 收尾即判噪声的字：官稱截斷（太、大、行、司、郎、副、曹、置）、地理族名（國、縣、道、麗、丹、巾、夷）、
// 注校書名（注、校、記、志、作）、賞賜物（紫、帶、金）、数目与虚词（一…十、百、千、萬、之、以、已、焉、者）。
const noiseTailChars = '大太行司郎副曹置揮麗丹巾臣紀志記注校作新正人夷省右左上下紫帶金幣以國縣道年十百千萬一二三四五六七八九等者之已焉也夫'
// 庙号/帝号打头再加一字必然不是人名（高祖受、秦王曰），整条丢弃。
const titlePrefixes = ['高祖', '太祖', '世祖', '太宗', '玄宗', '肅宗', '代宗', '德宗', '聖祖', '中宗', '睿宗', '武帝', '皇帝', '天子', '太后', '公主', '郡主']
const verbTailChars = new Set([...verbsAfter, ...verbsBefore])

// 句读边界，用于截取证据原文。
const boundaries = '。！？；：，、』」）)（'

const candidatePattern = new RegExp(`(?:[${surnameChars}]|${compoundSurnames.join('|')})[\\u4e00-\\u9fff]{1,2}`, 'g')

function isBoundary(char) {
	return boundaries.includes(char)
}

function sentenceEvidence(text, index, length) {
	let start = index
	while (start > 0 && !isBoundary(text[start - 1]) && index - start < 40) start -= 1
	let end = index + length
	while (end < text.length && !isBoundary(text[end]) && end - index - length < 40) end += 1
	const evidence = text.slice(start, Math.min(end, index + length + 40)).trim()
	return evidence.length >= 6 && evidence.length <= 90 ? evidence : text.slice(index, index + length)
}

// 返回单卷内的候选：mentions 为出现次数，evidence 是正文中真实存在的连续片段。
export function extractPersonCandidates(text) {
	const found = new Map()
	for (const match of text.matchAll(candidatePattern)) {
		const name = match[0]
		const tail = name.at(-1)
		if (name.includes('氏')) continue
		if (name.length === 3 && titlePrefixes.includes(name.slice(0, 2))) continue
		if (badTailChars.includes(tail) || noiseTailChars.includes(tail) || verbTailChars.has(tail)) continue
		const before = text.slice(Math.max(0, match.index - 2), match.index)
		const after = text.slice(match.index + name.length, match.index + name.length + 2)
		const hasAfter = verbsAfter.some((verb) => after.startsWith(verb))
		const hasBefore = verbsBefore.some((verb) => before.endsWith(verb))
		if (!hasAfter && !hasBefore) continue
		const previous = found.get(name)
		if (!previous) {
			found.set(name, { name, mentions: 1, evidence: sentenceEvidence(text, match.index, name.length) })
		} else {
			previous.mentions += 1
			// 证据优先留给动词在后的句式，读起来更像「某人做了某事」。
			if (previous.evidence === previous.name && hasAfter) previous.evidence = sentenceEvidence(text, match.index, name.length)
		}
	}
	return found
}

// 强关联的判据：两名在正文同一处窗口内共同出现（同句或相邻句）。
export function extractPersonEdges(text, names, { window = 160 } = {}) {
	const positions = []
	for (const name of names) {
		for (const match of text.matchAll(new RegExp(escapePattern(name), 'g'))) positions.push({ name, index: match.index })
	}
	positions.sort((a, b) => a.index - b.index)
	const edges = new Map()
	for (let i = 0; i < positions.length; i += 1) {
		for (let j = i + 1; j < positions.length && positions[j].index - positions[i].index <= window; j += 1) {
			const left = positions[i]
			const right = positions[j]
			if (left.name === right.name) continue
			const [a, b] = [left.name, right.name].sort()
			const key = `${a}\u0001${b}`
			// 只留两个名字都在内的连续原文片段（起点到第二个名字末尾）；截不出可读片段时留空，
			// 由调用方决定不生成关系，而不是写一条正文里并不存在的拼接串冒充证据。
			const span = text.slice(left.index, right.index + right.name.length)
			const evidence = span.length <= 90 ? span : ''
			const existing = edges.get(key)
			if (existing) {
				existing.co += 1
				if (!existing.evidence && evidence) existing.evidence = evidence
				continue
			}
			edges.set(key, { a, b, co: 1, evidence })
		}
	}
	return edges
}

function escapePattern(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
