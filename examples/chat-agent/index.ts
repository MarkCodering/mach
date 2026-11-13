/**
 *   bun examples/chat-agent/index.ts            # offline mock model
 *   ANTHROPIC_API_KEY=... bun examples/chat-agent/index.ts
 *
 * Then open http://localhost:3000, or:
 *   curl -N localhost:3000/chat -H 'content-type: application/json' -d '{"prompt":"What is the weather in Paris?"}'
 */
import { app } from './app.ts'

const port = Number(process.env.PORT ?? 3000)
export default { port, fetch: app.fetch, idleTimeout: 120 }
console.log(`Mach chat agent on http://localhost:${port}  (POST /chat, MCP at /mcp)`)
