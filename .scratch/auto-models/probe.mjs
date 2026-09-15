import { readFile } from 'node:fs/promises'
import { parsePricingPage } from '../../src/usage/deepseek-pricing-page.js'
const html = await readFile('test/fixtures/deepseek-pricing-page.html', 'utf8')
const result = parsePricingPage(html, { now: () => Date.UTC(2026, 8, 15, 4, 0), previousAliases: { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash', 'deepseek-old-gone': 'deepseek-flash' } })
console.log(JSON.stringify(result, null, 2))
