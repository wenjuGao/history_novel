import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
	poweredByHeader: false,
	distDir: process.env.HISTORY_TEST_BUILD === '1' ? '.next-test' : '.next',
	outputFileTracingRoot: process.cwd()
}

export default nextConfig
