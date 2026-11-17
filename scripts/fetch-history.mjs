import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = path.join(root, 'data/catalog/history-books.json')
const outputRoot = path.join(root, 'data/local/corpus/wikisource')
const host = 'zh.wikisource.org'
const userAgent = 'HistoryNovelResearchBot/0.1 (personal local corpus research)'
const minimumIntervalMs = 1200
const maximumHtmlBytes = 5 * 1024 * 1024
const maximumRetries = 3
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let lastRequestAt = 0

function parseArgs(argv) {
	const options = { book: null, limit: Infinity, refresh: false, retryFailed: false }
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === '--book') options.book = argv[++index] ?? null
		else if (argv[index] === '--limit') options.limit = Number(argv[++index])
		else if (argv[index] === '--refresh') options.refresh = true
		else if (argv[index] === '--retry-failed') options.retryFailed = true
		else if (argv[index] === '--help') options.help = true
		else throw new Error(`Unknown option: ${argv[index]}`)
	}
	if (!(options.limit > 0)) throw new Error('--limit must be a positive number.')
	return options
}

function allowedPageUrl(value) {
	const url = new URL(value, `https://${host}`)
	if (url.hostname !== host || url.protocol !== 'https:' || !url.pathname.startsWith('/wiki/')) {
		throw new Error(`Refusing non-article URL: ${url.href}`)
	}
	if (url.pathname.startsWith('/wiki/Special:')) throw new Error(`Refusing special page: ${url.href}`)
	url.hash = ''
	return url
}

function titleFromArticleUrl(url) {
	return decodeURIComponent(url.pathname.slice('/wiki/'.length))
}

function revisionId($, title) {
	for (const href of $('a[href*="oldid="]')
		.map((_, node) => $(node).attr('href'))
		.get()) {
		if (!href) continue
		const url = new URL(href, `https://${host}`)
		if (decodeURIComponent(url.searchParams.get('title') ?? '') !== title) continue
		const id = url.searchParams.get('oldid')
		if (id && /^\d+$/.test(id)) return id
	}
	return null
}

function licenseMarkers($) {
	const markers = $('.licensetpl')
		.map((_, node) => {
			const element = $(node)
			const classes = (element.attr('class') ?? '').split(/\s+/).filter(Boolean)
			const text = (selector) => element.find(selector).first().text().replace(/\s+/g, ' ').trim()
			return {
				templateClasses: classes,
				shortName: text('.licensetpl_short'),
				description: text('.licensetpl_long'),
				linkRequired: text('.licensetpl_link_req') === 'true',
				attributionRequired: text('.licensetpl_attr_req') === 'true'
			}
		})
		.get()
	return [...new Map(markers.map((marker) => [JSON.stringify(marker), marker])).values()]
}

function extractArticle(html, expectedTitle) {
	const $ = cheerio.load(html)
	const pageTitle = $('#firstHeading').first().text().trim()
	const content = $('#mw-content-text .mw-parser-output').first()
	if (!content.length || !pageTitle) throw new Error('Article body or title was not found.')
	if (pageTitle !== expectedTitle) throw new Error(`Unexpected article title: ${pageTitle}`)

	const markers = licenseMarkers($)
	const cleaned = content.clone()
	cleaned.find('script, style, .mw-editsection, .noprint, .catlinks, .navbox, .toc').remove()
	const htmlFragment = cleaned.html() ?? ''
	const textHtml = htmlFragment.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|table|blockquote|section)>/gi, '\n')
	const decoded = cheerio.load(textHtml).root().text()
	const text = decoded
		.split('\n')
		.map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
		.trim()

	if (text.length < 200) throw new Error(`Article text is unexpectedly short (${text.length} characters).`)
	return {
		pageTitle,
		oldid: revisionId($, expectedTitle),
		licenseMarkers: markers,
		text,
		html: htmlFragment,
		sha256: createHash('sha256').update(text, 'utf8').digest('hex')
	}
}

function volumePageUrls($, book) {
	const prefix = `/wiki/${book.title}/`
	const pages = new Map()
	$('#mw-content-text .mw-parser-output a[href^="/wiki/"]').each((_, node) => {
		const href = $(node).attr('href') ?? ''
		let decoded
		try {
			decoded = decodeURIComponent(href.split(/[?#]/)[0])
		} catch {
			return
		}
		if (!decoded.startsWith(prefix)) return
		const volumeName = decoded.slice(prefix.length)
		if (volumeName.includes('/')) return
		if (!/^(?:卷|第)?[0-9０-９一二三四五六七八九十百千〇零上下]+$/u.test(volumeName)) return
		const url = allowedPageUrl(href)
		pages.set(url.href, { title: titleFromArticleUrl(url), volumeName })
	})
	return [...pages.values()]
}

async function fetchArticle(url) {
	for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
		await delay(Math.max(0, minimumIntervalMs - (Date.now() - lastRequestAt)))
		lastRequestAt = Date.now()
		let response
		try {
			response = await fetch(url, {
				headers: { 'User-Agent': userAgent, Accept: 'text/html' },
				signal: AbortSignal.timeout(25000),
				redirect: 'manual'
			})
		} catch (error) {
			if (attempt === maximumRetries)
				throw new Error(`Network error after ${maximumRetries} retries: ${error instanceof Error ? error.message : String(error)}`)
			await delay((attempt + 1) * 5000)
			continue
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			if (!location) throw new Error(`Redirect without a Location header (${response.status}).`)
			const redirect = allowedPageUrl(new URL(location, url))
			return fetchArticle(redirect.href)
		}
		if (response.status === 429 || response.status >= 500) {
			if (attempt === maximumRetries) throw new Error(`HTTP ${response.status} after ${maximumRetries} retries.`)
			const retryAfter = Number(response.headers.get('retry-after'))
			await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 5000)
			continue
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const bytes = Buffer.from(await response.arrayBuffer())
		if (bytes.length > maximumHtmlBytes) throw new Error(`Response too large (${bytes.length} bytes).`)
		const html = bytes.toString('utf8')
		return { html, responseUrl: response.url, fetchedAt: new Date().toISOString() }
	}
	throw new Error('Request retry limit reached.')
}

function safeFileStem(value) {
	return Buffer.from(value, 'utf8').toString('base64url')
}

async function readJson(filePath) {
	try {
		return JSON.parse(await readFile(filePath, 'utf8'))
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
		throw error
	}
}

async function saveJson(filePath, data) {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(data)}\n`, { flag: 'wx' }).catch(async (error) => {
		if (error.code !== 'EEXIST') throw error
		await writeFile(filePath, `${JSON.stringify(data)}\n`)
	})
}

async function processBook(book, options) {
	const bookDirectory = path.join(outputRoot, book.id)
	const pagesDirectory = path.join(bookDirectory, 'pages')
	await mkdir(pagesDirectory, { recursive: true })

	const indexResponse = await fetchArticle(allowedPageUrl(book.indexUrl).href)
	const indexArticle = extractArticle(indexResponse.html, book.title)
	const $ = cheerio.load(indexResponse.html)
	const volumes = volumePageUrls($, book)
	const indexPath = path.join(bookDirectory, `index-${indexArticle.oldid ?? 'unversioned'}.json`)
	if (!(await readJson(indexPath)))
		await saveJson(indexPath, {
			bookId: book.id,
			bookName: book.name,
			sourceUrl: indexResponse.responseUrl,
			fetchedAt: indexResponse.fetchedAt,
			oldid: indexArticle.oldid,
			licenseMarkers: indexArticle.licenseMarkers,
			volumeCount: volumes.length,
			volumes
		})

	const previousStatus = await readJson(path.join(bookDirectory, 'status.json'))
	let selected = Number.isFinite(options.limit) ? volumes.slice(0, options.limit) : volumes
	if (options.retryFailed) {
		if (!previousStatus) throw new Error(`No prior status found for ${book.name}; run a normal collection first.`)
		const failedTitles = new Set((previousStatus.failures ?? []).map((failure) => failure.title))
		selected = volumes.filter((volume) => failedTitles.has(volume.title))
	}
	let downloaded = 0
	let skipped = 0
	const failures = []
	const existingFiles = new Set(await readdir(pagesDirectory))
	for (const volume of selected) {
		try {
			const pagePath = volume.title.split('/').map(encodeURIComponent).join('/')
			const pageUrl = allowedPageUrl(`/wiki/${pagePath}`).href
			const pageResponse = await fetchArticle(pageUrl)
			const canonicalUrl = allowedPageUrl(pageResponse.responseUrl)
			const pageTitle = cheerio.load(pageResponse.html)('#firstHeading').first().text().trim()
			const canonicalTitle = pageTitle || titleFromArticleUrl(canonicalUrl)
			if (!canonicalTitle.startsWith(`${book.title}/`) || canonicalTitle.slice(book.title.length + 1).includes('/')) {
				throw new Error(`Redirect left the expected book: ${canonicalTitle}`)
			}
			const article = extractArticle(pageResponse.html, canonicalTitle)
			const fileStem = `${safeFileStem(volume.title)}--${article.oldid ?? 'unversioned'}`
			const fileName = `${fileStem}.json`
			const htmlFileName = `${fileStem}.html.gz`
			const filePath = path.join(pagesDirectory, fileName)
			const htmlPath = path.join(pagesDirectory, htmlFileName)
			if (existingFiles.has(fileName) && !options.refresh) {
				const existing = await readJson(filePath)
				if (existing?.rawHtmlPath) {
					skipped += 1
					continue
				}
			}
			await writeFile(htmlPath, gzipSync(pageResponse.html), { flag: 'w' })
			await saveJson(filePath, {
				recordSchemaVersion: 1,
				bookId: book.id,
				bookName: book.name,
				volumeName: volume.volumeName,
				requestedTitle: volume.title,
				pageTitle: article.pageTitle,
				sourceUrl: pageResponse.responseUrl,
				sourceRevisionUrl: article.oldid
					? `https://${host}/w/index.php?title=${encodeURIComponent(article.pageTitle)}&oldid=${article.oldid}`
					: null,
				fetchedAt: pageResponse.fetchedAt,
				oldid: article.oldid,
				pageLicense: article.licenseMarkers,
				indexLicense: indexArticle.licenseMarkers,
				siteLicense: 'CC BY-SA 4.0',
				licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
				attribution: '维基文库贡献者',
				textTransformation: '由保存的Wikisource主内容HTML提取纯文本；原始HTML以gzip快照保留。',
				rawHtmlPath: path.relative(outputRoot, htmlPath),
				rawHtmlSha256: createHash('sha256').update(pageResponse.html, 'utf8').digest('hex'),
				text: article.text,
				textSha256: article.sha256,
				sha256: article.sha256
			})
			existingFiles.add(fileName)
			existingFiles.add(htmlFileName)
			downloaded += 1
		} catch (error) {
			failures.push({ title: volume.title, error: error instanceof Error ? error.message : String(error) })
			console.error(`[${book.name}] ${volume.title}: ${failures.at(-1).error}`)
		}
		if ((downloaded + skipped + failures.length) % 25 === 0) {
			console.log(`[${book.name}] ${downloaded} new, ${skipped} existing, ${failures.length} failed / ${selected.length}`)
		}
	}

	const result = {
		bookId: book.id,
		bookName: book.name,
		indexUrl: book.indexUrl,
		indexOldid: indexArticle.oldid,
		fetchedAt: new Date().toISOString(),
		observedVolumeCount: volumes.length,
		expectedPageCount: book.expectedPageCount,
		selectedCount: volumes.length,
		attemptedCount: selected.length,
		downloaded,
		skipped,
		failed: failures.length,
		failures,
		collectedPageCount: 0,
		missingPageCount: 0,
		complete: false
	}
	const storedFiles = new Set(await readdir(pagesDirectory))
	for (const volume of volumes) {
		const stem = `${safeFileStem(volume.title)}--`
		const storedJson = [...storedFiles].find((name) => name.startsWith(stem) && name.endsWith('.json'))
		if (!storedJson) continue
		const record = await readJson(path.join(pagesDirectory, storedJson))
		if (record?.bookId === book.id && record.rawHtmlPath) result.collectedPageCount += 1
	}
	result.missingPageCount = Math.max(0, result.expectedPageCount - result.collectedPageCount)
	result.complete = result.observedVolumeCount === result.expectedPageCount && result.missingPageCount === 0 && result.failed === 0
	await saveJson(path.join(bookDirectory, 'status.json'), result)
	console.log(`[${book.name}] ${JSON.stringify(result)}`)
	return result
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (options.help) {
		console.log('Usage: npm run corpus:fetch [-- --book shiji] [--limit 2] [--refresh] [--retry-failed]')
		return
	}
	const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
	if (catalog.source.host !== host || catalog.books.length !== 25) throw new Error('Unexpected corpus catalog or source host.')
	const books = options.book ? catalog.books.filter((book) => book.id === options.book) : catalog.books
	if (!books.length) throw new Error(`Unknown book id: ${options.book}`)
	const results = []
	for (const book of books) results.push(await processBook(book, options))
	const bookStatuses = []
	for (const book of catalog.books) {
		const status = await readJson(path.join(outputRoot, book.id, 'status.json'))
		bookStatuses.push(
			status ?? {
				bookId: book.id,
				bookName: book.name,
				expectedPageCount: book.expectedPageCount,
				collectedPageCount: 0,
				missingPageCount: book.expectedPageCount,
				failed: 0,
				complete: false
			}
		)
	}
	const summary = {
		generatedAt: new Date().toISOString(),
		source: catalog.source,
		books: bookStatuses,
		totalExpected: bookStatuses.reduce((sum, item) => sum + item.expectedPageCount, 0),
		totalCollected: bookStatuses.reduce((sum, item) => sum + item.collectedPageCount, 0),
		totalMissing: bookStatuses.reduce((sum, item) => sum + item.missingPageCount, 0),
		totalFailed: bookStatuses.reduce((sum, item) => sum + item.failed, 0),
		complete: bookStatuses.length === catalog.books.length && bookStatuses.every((item) => item.complete)
	}
	await saveJson(path.join(outputRoot, 'report.json'), summary)
	if (summary.totalFailed > 0) process.exitCode = 1
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
