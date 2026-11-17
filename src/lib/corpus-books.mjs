// 默认 25 部古籍的覆盖年代（历史纪年：公元前为负数、无零年）。
// 数值取各书叙事所及的大致起讫，precision 一律标 approx，用于时间阶段筛书，不作史实断言。
export const corpusBooks = [
	{ id: 'shiji', name: '史记', title: '史記', category: '二十四史', volumes: 130, startYear: -2000, endYear: 122 },
	{ id: 'hanshu', name: '汉书', title: '漢書', category: '二十四史', volumes: 107, startYear: -206, endYear: 23 },
	{ id: 'houhanshu', name: '后汉书', title: '後漢書', category: '二十四史', volumes: 130, startYear: 23, endYear: 220 },
	{ id: 'sanguozhi', name: '三国志', title: '三國志', category: '二十四史', volumes: 65, startYear: 184, endYear: 280 },
	{ id: 'jinshu', name: '晋书', title: '晉書', category: '二十四史', volumes: 130, startYear: 221, endYear: 420 },
	{ id: 'songshu', name: '宋书', title: '宋書', category: '二十四史', volumes: 100, startYear: 420, endYear: 479 },
	{ id: 'nanqishu', name: '南齐书', title: '南齊書', category: '二十四史', volumes: 59, startYear: 479, endYear: 502 },
	{ id: 'liangshu', name: '梁书', title: '梁書', category: '二十四史', volumes: 56, startYear: 502, endYear: 557 },
	{ id: 'chenshu', name: '陈书', title: '陳書', category: '二十四史', volumes: 36, startYear: 557, endYear: 589 },
	{ id: 'weishu', name: '魏书', title: '魏書', category: '二十四史', volumes: 120, startYear: 386, endYear: 557 },
	{ id: 'beiqishu', name: '北齐书', title: '北齊書', category: '二十四史', volumes: 50, startYear: 550, endYear: 577 },
	{ id: 'zhoushu', name: '周书', title: '周書', category: '二十四史', volumes: 50, startYear: 535, endYear: 581 },
	{ id: 'suishu', name: '隋书', title: '隋書', category: '二十四史', volumes: 85, startYear: 541, endYear: 618 },
	{ id: 'nanshi', name: '南史', title: '南史', category: '二十四史', volumes: 80, startYear: 420, endYear: 589 },
	{ id: 'beishi', name: '北史', title: '北史', category: '二十四史', volumes: 100, startYear: 386, endYear: 618 },
	{ id: 'jiutangshu', name: '旧唐书', title: '舊唐書', category: '二十四史', volumes: 213, startYear: 616, endYear: 907 },
	{ id: 'xintangshu', name: '新唐书', title: '新唐書', category: '二十四史', volumes: 245, startYear: 616, endYear: 907 },
	{ id: 'jiuwudaishi', name: '旧五代史', title: '舊五代史', category: '二十四史', volumes: 150, startYear: 874, endYear: 960 },
	{ id: 'xinwudaishi', name: '新五代史', title: '新五代史', category: '二十四史', volumes: 74, startYear: 874, endYear: 960 },
	{ id: 'songshi', name: '宋史', title: '宋史', category: '二十四史', volumes: 496, startYear: 927, endYear: 1279 },
	{ id: 'liaoshi', name: '辽史', title: '遼史', category: '二十四史', volumes: 116, startYear: 907, endYear: 1125 },
	{ id: 'jinshi', name: '金史', title: '金史', category: '二十四史', volumes: 135, startYear: 1070, endYear: 1234 },
	{ id: 'yuanshi', name: '元史', title: '元史', category: '二十四史', volumes: 210, startYear: 1206, endYear: 1368 },
	{ id: 'mingshi', name: '明史', title: '明史', category: '二十四史', volumes: 332, startYear: 1352, endYear: 1644 },
	{ id: 'zizhitongjian', name: '资治通鉴', title: '資治通鑑', category: '补充必含', volumes: 294, startYear: -403, endYear: 959 },
]

// 表内 startYear/endYear 是历史纪年（公元前为负、无零年）；落库与比较统一用天文纪年，与 project_scope 一致。
export function astronomicalYear(year) {
	return year <= 0 ? year + 1 : year
}
