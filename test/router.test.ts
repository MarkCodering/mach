import { describe, expect, test } from 'bun:test'
import { compilePattern, getPath, Router } from '../src/router.ts'

describe('Router', () => {
  test('static routes', () => {
    const r = new Router<string>()
    r.add('GET', '/', 'root')
    r.add('GET', '/users', 'users')
    expect(r.match('GET', '/')?.value).toBe('root')
    expect(r.match('GET', '/users')?.value).toBe('users')
    expect(r.match('GET', '/users/')?.value).toBe('users')
    expect(r.match('POST', '/users')).toBeNull()
    expect(r.match('GET', '/nope')).toBeNull()
  })

  test('params, priority and backtracking', () => {
    const r = new Router<string>()
    r.add('GET', '/users/:id', 'user')
    r.add('GET', '/users/me', 'me')
    r.add('GET', '/users/:id/posts/:postId', 'post')
    r.add('GET', '/users/:id/settings', 'settings')
    expect(r.match('GET', '/users/me')?.value).toBe('me')
    expect(r.match('GET', '/users/42')).toEqual({ value: 'user', params: { id: '42' } })
    expect(r.match('GET', '/users/42/posts/7')).toEqual({ value: 'post', params: { id: '42', postId: '7' } })
    expect(r.match('GET', '/users/me/settings')).toEqual({ value: 'settings', params: { id: 'me' } })
    expect(r.match('GET', '/users/42/unknown')).toBeNull()
    expect(r.match('GET', '/users/')).toBeNull()
  })

  test('wildcards', () => {
    const r = new Router<string>()
    r.add('GET', '/files/*', 'files')
    r.add('GET', '/files/special', 'special')
    expect(r.match('GET', '/files/special')?.value).toBe('special')
    expect(r.match('GET', '/files/a/b/c.txt')).toEqual({ value: 'files', params: { '*': 'a/b/c.txt' } })
    expect(r.match('GET', '/files')).toEqual({ value: 'files', params: { '*': '' } })
  })

  test('optional trailing param', () => {
    const r = new Router<string>()
    r.add('GET', '/docs/:page?', 'docs')
    expect(r.match('GET', '/docs')?.value).toBe('docs')
    expect(r.match('GET', '/docs/intro')).toEqual({ value: 'docs', params: { page: 'intro' } })
  })

  test('decodes params', () => {
    const r = new Router<string>()
    r.add('GET', '/q/:term', 'q')
    expect(r.match('GET', '/q/hello%20world')?.params.term).toBe('hello world')
    expect(r.match('GET', '/q/%E0%A4%A')?.params.term).toBe('%E0%A4%A') // malformed stays raw
  })

  test('rejects duplicates; param names may differ between routes', () => {
    const r = new Router<string>()
    r.add('GET', '/a', 'a')
    expect(() => r.add('GET', '/a', 'b')).toThrow(/already registered/)
    r.add('GET', '/u/:id', 'u')
    r.add('GET', '/u/:userId/x', 'x')
    expect(r.match('GET', '/u/1')?.params).toEqual({ id: '1' })
    expect(r.match('GET', '/u/2/x')?.params).toEqual({ userId: '2' })
    expect(() => r.add('GET', '/u/:other', 'dup')).toThrow(/already registered/)
    expect(() => r.add('GET', '/d/:a/:a', 'd')).toThrow(/Duplicate param name/)
    expect(() => r.add('GET', '/w/*/x', 'w')).toThrow(/last segment/)
  })

  test('precedence matches a backtracking trie', () => {
    const r = new Router<string>()
    r.add('GET', '/files/*', 'wild')
    r.add('GET', '/files/:a/:b', 'two')
    r.add('GET', '/files/:a/raw', 'raw')
    r.add('GET', '/x/:a/y', 'param-first')
    r.add('GET', '/x/b/:c', 'static-first')
    expect(r.match('GET', '/files/x/y')?.value).toBe('two')
    expect(r.match('GET', '/files/x/raw')?.value).toBe('raw')
    expect(r.match('GET', '/files/x/y/z')?.value).toBe('wild')
    expect(r.match('GET', '/x/b/y')?.value).toBe('static-first')
    expect(r.match('GET', '/x/q/y')?.value).toBe('param-first')
    expect(r.match('GET', '/x/b/y/')?.value).toBe('static-first')
  })

  test('special characters in static segments are literal', () => {
    const r = new Router<string>()
    r.add('GET', '/v1.0/:id', 'dot')
    expect(r.match('GET', '/v1.0/5')?.value).toBe('dot')
    expect(r.match('GET', '/v1x0/5')).toBeNull()
  })

  test('allowed methods', () => {
    const r = new Router<string>()
    r.add('GET', '/x/:id', 'g')
    r.add('DELETE', '/x/:id', 'd')
    expect(r.allowed('/x/1').sort()).toEqual(['DELETE', 'GET'])
  })
})

describe('getPath', () => {
  test('extracts pathname without query or hash', () => {
    expect(getPath('http://localhost/a/b?x=1')).toBe('/a/b')
    expect(getPath('https://example.com:8080/')).toBe('/')
    expect(getPath('http://h/p#frag')).toBe('/p')
    expect(getPath('http://h')).toBe('/')
  })
})

describe('compilePattern', () => {
  test('patterns', () => {
    expect(compilePattern('*')('/anything')).toBe(true)
    const api = compilePattern('/api/*')
    expect(api('/api')).toBe(true)
    expect(api('/api/x/y')).toBe(true)
    expect(api('/apix')).toBe(false)
    expect(compilePattern('/exact')('/exact')).toBe(true)
    expect(compilePattern('/exact')('/exact/x')).toBe(false)
    expect(compilePattern('/u/:id/edit')('/u/3/edit')).toBe(true)
    expect(compilePattern('/u/:id/edit')('/u/3/view')).toBe(false)
  })
})
