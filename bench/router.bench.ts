/**
 * Router micro-benchmark: route lookup only (no HTTP).
 *   bun bench/router.bench.ts
 */
import FindMyWay from 'find-my-way'
import { RegExpRouter } from 'hono/router/reg-exp-router'
import { TrieRouter } from 'hono/router/trie-router'
import { bench, group, run, summary } from 'mitata'
import { Router } from '../src/router.ts'
import { requests, routes } from './routes.ts'

const mach = new Router<string>()
const honoRegExp = new RegExpRouter<string>()
const honoTrie = new TrieRouter<string>()
const fmw = FindMyWay()

for (const [method, path] of routes) {
  mach.add(method, path, path)
  honoRegExp.add(method, path, path)
  honoTrie.add(method, path, path)
  fmw.on(method as 'GET', path, () => {})
}

// Sanity check: every router must resolve every request.
for (const r of requests) {
  if (!mach.match(r.method, r.path)) throw new Error(`mach failed ${r.path}`)
  if (!honoRegExp.match(r.method, r.path)[0].length) throw new Error(`hono failed ${r.path}`)
  if (!fmw.find(r.method as 'GET', r.path)) throw new Error(`find-my-way failed ${r.path}`)
}

summary(() => {
  group('all requests (one lookup each)', () => {
    bench('mach Router', () => {
      for (const r of requests) mach.match(r.method, r.path)
    })
    bench('hono RegExpRouter', () => {
      for (const r of requests) honoRegExp.match(r.method, r.path)
    })
    bench('hono TrieRouter', () => {
      for (const r of requests) honoTrie.match(r.method, r.path)
    })
    bench('find-my-way', () => {
      for (const r of requests) fmw.find(r.method as 'GET', r.path)
    })
  })
})

for (const r of [requests[0]!, requests[2]!, requests[7]!]) {
  summary(() => {
    group(r.name, () => {
      bench('mach Router', () => mach.match(r.method, r.path))
      bench('hono RegExpRouter', () => honoRegExp.match(r.method, r.path))
      bench('find-my-way', () => fmw.find(r.method as 'GET', r.path))
    })
  })
}

await run()
