// 年纪锚点解析：资治通鉴按年编排，卷内标题行带绝对纪年（如「孝安皇帝元初三年（丙辰，公元一一六年）」
// 或「顯王元年〈癸丑，西元前三六八年〉」），标题之下的每一行是一条可定年的记事。
// 本模块只做纯文本解析与聚合，不碰数据库、不调模型，结果一律标 needs_review 待人工核对。

export const YEAR_ANCHORED_BOOKS = ['zizhitongjian']

const STEMS = '甲乙丙丁戊己庚辛壬癸'
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥'
const DIGITS = { '〇': 0, '○': 0, '零': 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

// 年号标题里的公元数既有一一二这类逐位写法，也偶见三十这类十进制写法。
export function parseChineseYear(raw) {
	const text = raw.trim()
	if (!text) return null
	if (/^[0-9]+$/.test(text)) return Number(text)
	if (!/^[〇○零一二三四五六七八九十百]+$/.test(text)) return null
	if (!/[十百]/.test(text)) {
		let digits = ''
		for (const char of text) {
			const value = /[0-9]/.test(char) ? Number(char) : DIGITS[char]
			if (value === undefined) return null
			digits += String(value)
		}
		return Number(digits)
	}
	let total = 0
	let current = 0
	for (const char of text) {
		if (char === '十') {
			total += (current || 1) * 10
			current = 0
		} else if (char === '百') {
			total += (current || 1) * 100
			current = 0
		} else {
			const value = /[0-9]/.test(char) ? Number(char) : DIGITS[char]
			if (value === undefined) return null
			current = value
		}
	}
	return total + current
}

// 一行的行尾括号注记若是绝对纪年，就是年纪标题。卷内有「〈（壬辰，公元三九二年）〉」这种嵌套写法，
// 因此取行内最后一个成对括号，而不是要求括号贴着行尾。
export function parseYearHeading(line) {
	const text = line.trim()
	if (!text || text.length > 60) return null
	if (!/公元|西元/.test(text)) return null
	const groups = [...text.matchAll(/[（〈(]([^（〉()）]{2,26})[）〉)]/g)]
	if (!groups.length) return null
	const last = groups[groups.length - 1]
	if (text.length - (last.index + last[0].length) > 1) return null
	const inner = last[1]
	const match = inner.match(/(西元前|公元前|後漢|公元|西元)\s*([0-9〇○零一二三四五六七八九十百]+)\s*年?/)
	if (!match) return null
	if (match[1] === '後漢') return null
	const value = parseChineseYear(match[2])
	if (value === null || value <= 0 || value > 4000) return null
	// 存储统一用天文纪年（公元前为负、无零年），与 project_scope 一致。
	const astronomical = match[1] === '西元前' || match[1] === '公元前' ? -(value - 1) : value
	const ganzhi = inner.match(new RegExp(`[${STEMS}][${BRANCHES}]`))
	return { year: astronomical, label: text, ganzhi: ganzhi ? ganzhi[0] : null, ganzhiMatches: ganzhi ? ganzhiOf(astronomical) === ganzhi[0] : null }
}

export function ganzhiOf(astronomicalYear) {
	const index = ((astronomicalYear - 4) % 60 + 60) % 60
	return STEMS[index % 10] + BRANCHES[index % 12]
}

export function buildNameIndex(names) {
	const index = new Map()
	for (const name of names) {
		if (!name || name.length < 2) continue
		const key = name[0]
		const list = index.get(key) ?? []
		list.push(name)
		index.set(key, list)
	}
	for (const list of index.values()) list.sort((a, b) => b.length - a.length)
	return index
}

// 逐位扫描比 3000 个名字做 includes 快一个量级；只认索引里已有的写法（繁简混排由索引决定）。
export function matchNames(text, index) {
	const found = new Set()
	for (let i = 0; i < text.length; i += 1) {
		const candidates = index.get(text[i])
		if (!candidates) continue
		for (const name of candidates) {
			if (text.startsWith(name, i)) found.add(name)
		}
	}
	return [...found]
}

const DEATH_MARKERS = ['薨', '殂', '崩', '卒', '誅', '殁', '歿', '殞', '賜死', '伏誅', '伏法', '棄市', '遇害', '自殺']
// 只允许「人名＋（少量虛字）＋死亡詞」的主語句式：
// 「曹操當死數矣」「聞孫策死」这类后世追述与旁人死去都不算，因此不用裸「死／殺」做标记。
const DEATH_GAP = '病老亦坐且已長幼'
// 兵卒/士卒/走卒的「卒」不是人物死亡，山崩/堤崩的「崩」也不是，用前后字排除。
const DEATH_TRAP_BEFORE = { 卒: '士走兵徒吏小大軍行', 崩: '山岸城堤石陵陵崩', 誅: '討擊攻殺' }
const DEATH_TRAP_AFTER = { 卒: '伍從役', 崩: '壞裂陷', 死: '戰不地法罪休所疑', 誅: '之其者等' }

export function deathMarkerAt(text, nameEnd) {
	const window = text.slice(nameEnd, nameEnd + 8)
	for (const marker of DEATH_MARKERS) {
		const offset = window.indexOf(marker)
		if (offset < 0 || offset > 2) continue
		const gap = window.slice(0, offset)
		if (/[。；！？，、]/.test(gap)) continue
		if ([...gap].some((char) => !DEATH_GAP.includes(char))) continue
		const before = text[nameEnd + offset - 1] ?? ''
		const after = text[nameEnd + offset + marker.length] ?? ''
		if ((DEATH_TRAP_BEFORE[marker] ?? '').includes(before) || (DEATH_TRAP_BEFORE[marker] ?? '').includes(after)) continue
		if ((DEATH_TRAP_AFTER[marker] ?? '').includes(after)) continue
		return { marker, at: nameEnd + offset }
	}
	return null
}

const AGE_PATTERN = /年([〇○零一二三四五六七八九十百]+)\s*(?:歲|岁)/

// 「年十七」这类记载只能推出一个近似生年（虚岁），精度一律标 approx。
export function birthFromAge(text, nameEnd, year) {
	const window = text.slice(nameEnd, nameEnd + 14)
	const match = window.match(AGE_PATTERN)
	if (!match) return null
	const age = parseChineseYear(match[1])
	if (age === null || age < 1 || age > 120) return null
	return year - age + 1
}

const NOISE_PREFIX = /^目錄|^►|^◄|^資治通鑑|^臣光曰|^起.{2,12}，盡|^[〈《]|^第[〇○零一二三四五六七八九十百]+卷/

export function isEntryNoise(line) {
	const text = line.trim()
	if (text.length < 6) return true
	if (NOISE_PREFIX.test(text)) return true
	// 卷题行（「巻一」「卷第二」）与「凡三十五年」这类范围说明不是记事。
	if (/^[巻卷][〇○零一二三四五六七八九十百]+$/.test(text)) return true
	if (/^凡[〇○零一二三四五六七八九十百]+年/.test(text)) return true
	return false
}

const MONTH_PREFIX = /^(?:正|閏|[一二三四五六七八九十]+)月/
const STEM_BRANCH = new RegExp(`^[${STEMS}][${BRANCHES}]，`)

// 句首的季节/月份/干支日只作为条目的时间标签保留，正文从其后起算。
export function splitPeriod(line) {
	const text = line.trim()
	const parts = []
	let rest = text
	const season = rest.match(/^(春|夏|秋|冬)，/)
	if (season) {
		parts.push(season[1])
		rest = rest.slice(season[0].length)
	}
	const month = rest.match(MONTH_PREFIX)
	if (month && rest.length > month[0].length + 2) {
		parts.push(month[0])
		rest = rest.slice(month[0].length).replace(/^[，、]/, '')
	}
	const day = rest.match(STEM_BRANCH)
	if (day && rest.length > day[0].length + 2) {
		parts.push(day[0].replace(/，$/, ''))
		rest = rest.slice(day[0].length)
	}
	const numbered = rest.match(/^[0-9]+　/)
	if (numbered) rest = rest.slice(numbered[0].length)
	return { period: parts.join('·'), body: rest.trim() }
}

// 证据要能原样回到《原文》里比对，因此只在句读处截断，不做改写或繁简转换。
export function clipText(text, limit = 150) {
	if (text.length <= limit) return text
	const head = text.slice(0, limit)
	const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'))
	return cut > 24 ? head.slice(0, cut + 1) : head
}

// 卷内解析：先记下所有年纪标题的位置，再按相邻标题是否连年决定该段记事的年份精度。
export function indexVolume(text, nameIndex, { carryYear = null, carryLabel = '' } = {}) {
	const lines = text.split('\n')
	const anchors = []
	for (let i = 0; i < lines.length; i += 1) {
		const heading = parseYearHeading(lines[i])
		if (heading) anchors.push({ line: i, ...heading })
	}
	const entries = []
	let current = anchors.length ? null : { year: carryYear, label: carryLabel }
	for (let i = 0; i < lines.length; i += 1) {
		const anchorIndex = anchors.findIndex((anchor) => anchor.line === i)
		if (anchorIndex >= 0) {
			const previous = anchors[anchorIndex - 1]
			const next = anchors[anchorIndex + 1]
			// 上一标题与本标题不连年，说明中间有标题未被识别，落在两标题之间的记事精度降级。
			const gapBefore = anchorIndex > 0 ? previous.year + 1 !== anchors[anchorIndex].year : carryYear !== null && carryYear + 1 !== anchors[anchorIndex].year
			current = {
				year: anchors[anchorIndex].year,
				label: anchors[anchorIndex].label,
				approx: gapBefore || (!!next && next.year !== anchors[anchorIndex].year + 1),
			}
			continue
		}
		if (!current || current.year === null) continue
		const line = lines[i].trim()
		if (!line || isEntryNoise(line)) continue
		const { period, body } = splitPeriod(line)
		if (body.length < 6) continue
		const names = matchNames(body, nameIndex)
		if (!names.length) continue
		const deaths = new Map()
		for (const name of names) {
			let from = 0
			for (;;) {
				const at = body.indexOf(name, from)
				if (at < 0) break
				const marker = deathMarkerAt(body, at + name.length)
				if (marker) deaths.set(name, marker)
				from = at + name.length
			}
		}
		entries.push({
			line: i,
			year: current.year,
			yearLabel: current.label,
			yearPrecision: current.approx ? 'approx' : 'exact',
			period,
			text: clipText(body),
			names,
			deaths: [...deaths.entries()].map(([name, marker]) => ({ name, marker: marker.marker })),
		})
	}
	const lastAnchor = anchors[anchors.length - 1]
	return { entries, carryYear: lastAnchor ? lastAnchor.year : carryYear, carryLabel: lastAnchor ? lastAnchor.label : carryLabel, anchors: anchors.length }
}

const VERBS = '擊攻破斬伐討誅圍降奔敗擒獲戰赦封拜貶賜遷立廢弑篡執虜克陷平救屯殺'

export function deedScore(entry, name) {
	const at = entry.text.indexOf(name)
	let score = 0
	if (at >= 0 && at <= 4) score += 4
	if (entry.deaths.some((death) => death.name === name)) score += 3
	if (entry.text.length >= 14 && entry.text.length <= 90) score += 2
	for (const verb of VERBS) if (entry.text.includes(verb)) { score += 1; break }
	if (entry.yearPrecision === 'exact') score += 1
	return score
}

// 主要事迹取分值最高的若干条，并按年份排序后截断，界面直接展示「年＋一句话＋出处卷」。
// 条目需带 volumeName/sourceUrl（索引器在入库前挂载），事迹引用才能回到原文核对。
export function pickDeeds(entries, name, { limit = 5 } = {}) {
	const scored = entries
		.filter((entry) => entry.names.includes(name))
		.map((entry) => ({ entry, score: deedScore(entry, name) }))
		.sort((a, b) => b.score - a.score || a.entry.year - b.entry.year)
		.slice(0, limit)
	return scored
		.map(({ entry }) => ({
			year: entry.year,
			text: clipText(entry.text, 90),
			period: entry.period,
			volume: entry.volumeName ?? '',
			book: entry.bookName ?? '',
			url: entry.sourceUrl ?? '',
		}))
		.sort((a, b) => a.year - b.year)
}

// 人名被后世议论追述（263 年有人评「曹操雖功蓋中夏」，825 年又提「秦始皇」）会把区间拉到几百年后。
// 规则：先用固定长度窗口取最密的记事段作种子，再按相邻年份向两侧链接扩展；
// 单纯聚类会在记事稀疏时塌成一年，单纯分位法又会把远处的追述留在区间内。
export function coreInterval(years, { window = 30, extendGap = 8 } = {}) {
	if (!years.length) return null
	const sorted = [...years].sort((a, b) => a - b)
	// 记事太少时无法判断哪个是追述，宁可不修剪，交给人工核对。
	if (sorted.length <= 4) return { start: sorted[0], end: sorted[sorted.length - 1], outside: 0, trimmed: false }
	let seed = sorted[0]
	let seedCount = -1
	for (const candidate of sorted) {
		const covered = sorted.filter((year) => year >= candidate && year <= candidate + window).length
		if (covered > seedCount) {
			seedCount = covered
			seed = candidate
		}
	}
	let start = seed
	let end = seed + window
	for (;;) {
		const previous = sorted.filter((year) => year < start).pop()
		if (previous === undefined || start - previous > extendGap) break
		start = previous
	}
	for (;;) {
		const next = sorted.find((year) => year > end)
		if (next === undefined || next - end > extendGap) break
		end = next
	}
	const inside = sorted.filter((year) => year >= start && year <= end)
	const first = inside.length ? inside[0] : seed
	const last = inside.length ? inside[inside.length - 1] : seed
	return { start: first, end: last, outside: sorted.length - inside.length, trimmed: sorted.length !== inside.length }
}

// 人物年份档案由带年纪事聚合而来：生卒未知一律留空，不用书目年代代填（REQ-054）。
// 卒年只认活动区间之内、或紧随其后（deathTail 年内）的死亡记事——死于任上常落在窗口之外；
// 更晚出现的「某人薨」多是后世追述，不算本人死亡。
export function buildProfile(name, entries, { deedsLimit = 5, window = 30, deathTail = 20 } = {}) {
	const owned = entries.filter((entry) => entry.names.includes(name))
	if (!owned.length) return null
	const core = coreInterval(owned.map((entry) => entry.year), { window })
	const deathEntries = owned.filter(
		(entry) => entry.deaths.some((death) => death.name === name) && entry.year >= core.start && entry.year <= core.end + deathTail,
	)
	const death = deathEntries.length ? Math.min(...deathEntries.map((entry) => entry.year)) : null
	const lastYear = death !== null ? Math.min(core.end, death) : core.end
	const inside = owned.filter((entry) => entry.year >= core.start && entry.year <= lastYear)
	let birth = null
	let birthPrecision = 'unknown'
	for (const entry of inside) {
		const at = entry.text.indexOf(name)
		if (at < 0) continue
		const value = birthFromAge(entry.text, at + name.length, entry.year)
		if (value !== null) {
			birth = value
			birthPrecision = 'approx'
			break
		}
	}
	return {
		name,
		birth,
		birthPrecision: birth === null ? 'unknown' : birthPrecision,
		death,
		deathPrecision: death === null ? 'unknown' : deathEntries.some((entry) => entry.yearPrecision === 'approx') ? 'approx' : 'exact',
		firstYear: core.start,
		// 卒年已知时活动区间不得晚于卒年：更晚的记事只能是追述。
		lastYear,
		laterMentions: core.outside,
		intervalTrimmed: core.trimmed,
		entryCount: owned.length,
		deeds: pickDeeds(inside, name, { limit: deedsLimit }),
	}
}
