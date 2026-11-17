import 'server-only'

import type { NextRequest } from 'next/server'

export function isLoopbackHost(hostname: string) {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export function isLoopbackRequest(request: NextRequest) {
	const host = request.headers.get('host')
	if (!host) return false

	try {
		return isLoopbackHost(new URL(`http://${host}`).hostname)
	} catch {
		return false
	}
}

export function isSameOriginLoopback(request: NextRequest) {
	const origin = request.headers.get('origin')
	const host = request.headers.get('host')
	if (!origin || !host) return false

	try {
		const originUrl = new URL(origin)
		const hostUrl = new URL(`${originUrl.protocol}//${host}`)
		return hostUrl.host === host && originUrl.host === host && isLoopbackHost(originUrl.hostname)
	} catch {
		return false
	}
}
