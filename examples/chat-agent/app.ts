/**
 * An AI agent with tools, streamed over SSE, with the same tools exposed over MCP.
 * Uses Claude when ANTHROPIC_API_KEY is set, otherwise a scripted mock model (offline).
 */
import { Mach, s } from 'machjs'
import { agent, tool, type Model } from 'machjs/ai'
import { anthropic } from 'machjs/ai/anthropic'
import { lastToolOutput, mockModel } from 'machjs/ai/mock'
import { mcpServer } from 'machjs/mcp'
import { bodyLimit, cors, logger } from 'machjs/middleware'

// ── Tools: defined once, used by the agent AND exposed over MCP ──────────────
export const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input: s.object({
    city: s.string().describe('City name, e.g. "Paris"'),
    unit: s.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  run: async ({ city, unit }) => {
    // Replace with a real weather API call.
    const tempC = 12 + (city.length % 15)
    return { city, unit, temperature: unit === 'celsius' ? tempC : Math.round(tempC * 1.8 + 32), conditions: 'partly cloudy' }
  },
})

export const convertCurrency = tool({
  name: 'convert_currency',
  description: 'Convert an amount between currencies using fixed demo rates.',
  input: s.object({ amount: s.number(), from: s.enum(['USD', 'EUR', 'GBP']), to: s.enum(['USD', 'EUR', 'GBP']) }),
  run: ({ amount, from, to }) => {
    const usd = { USD: 1, EUR: 1.08, GBP: 1.27 }
    return { amount: Math.round(((amount * usd[from]) / usd[to]) * 100) / 100, currency: to }
  },
})

const tools = [getWeather, convertCurrency]

// ── Model: Claude if a key is present, otherwise an offline mock ─────────────
function pickModel(): Model {
  if (process.env.ANTHROPIC_API_KEY) return anthropic('claude-opus-5-5')
  return mockModel(
    (req) => {
      const last = req.messages.at(-1)
      if (last?.role === 'tool') {
        const w = lastToolOutput(req) as { city: string; temperature: number; conditions: string }
        return `It's ${w.temperature}°C and ${w.conditions} in ${w.city}.`
      }
      const text = typeof last?.content === 'string' ? last.content : ''
      const city = /in ([A-Z][a-z]+)/.exec(text)?.[1]
      return city
        ? { text: `Let me check the weather in ${city}. `, toolCalls: [{ name: 'get_weather', input: { city } }] }
        : 'Ask me about the weather in a city, e.g. "What is the weather in Paris?"'
    },
    { delayMs: 15 },
  )
}

export const assistant = agent({
  model: pickModel(),
  system: 'You are a concise assistant. Use tools when they help.',
  tools,
  maxSteps: 8,
})

// ── App ──────────────────────────────────────────────────────────────────────
export const app = new Mach()
  .use(logger(), cors(), bodyLimit(1_000_000))
  .get('/', (c) => c.html(PAGE))
  .agent('/chat', assistant)
  .mcp('/mcp', mcpServer({ name: 'mach-demo', version: '0.1.0', tools }))

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mach chat</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 720px; margin: 0 auto; padding: 16px; }
  #log { white-space: pre-wrap; line-height: 1.5; min-height: 200px; }
  .tool { opacity: .7; font-size: .9em; font-family: ui-monospace, monospace; }
  form { display: flex; gap: 8px; margin-top: 16px; }
  input { flex: 1; padding: 8px; font-size: 16px; }
</style></head>
<body>
<h1>Mach chat</h1>
<div id="log"></div>
<form id="f"><input id="q" autocomplete="off" placeholder="What is the weather in Paris?" autofocus><button>Send</button></form>
<script type="module">
  const log = document.getElementById('log'), messages = []
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault()
    const q = document.getElementById('q'); const content = q.value.trim(); if (!content) return
    q.value = ''; messages.push({ role: 'user', content })
    log.append('\\nYou: ' + content + '\\nAssistant: ')
    const res = await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read(); if (done) break
      buf += value
      let i
      while ((i = buf.indexOf('\\n\\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = frame.split('\\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\\n')
        if (!data) continue
        const ev = JSON.parse(data)
        if (ev.type === 'text-delta') log.append(ev.text)
        if (ev.type === 'tool-call') { const s = document.createElement('div'); s.className = 'tool'; s.textContent = '→ ' + ev.name + ' ' + JSON.stringify(ev.input); log.append(s) }
        if (ev.type === 'message') messages.push(ev.message)
      }
    }
  }
</script>
</body></html>`
