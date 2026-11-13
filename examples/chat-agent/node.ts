/**
 * The same app on Node.js' built-in HTTP server.
 *
 *   bun examples/chat-agent/node.ts
 */
import { serve } from 'machjs/node'
import { app } from './app.ts'

serve(app, { port: Number(process.env.PORT ?? 3000) })
