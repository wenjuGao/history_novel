import { FlatCompat } from '@eslint/eslintrc'
import { globalIgnores } from 'eslint/config'

const compat = new FlatCompat({ baseDirectory: import.meta.dirname })

export default [...compat.extends('next/core-web-vitals', 'next/typescript'), globalIgnores(['.next/**', '.next-test/**', 'out/**', 'build/**', 'next-env.d.ts', 'data/**'])]
