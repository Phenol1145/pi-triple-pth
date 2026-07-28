import type { FastifyReply } from "fastify";

/**
 * Write Server-Sent Events stream via a Fastify reply raw socket.
 * Extracted from routes-sessions.ts so both session SSE and program-run
 * SSE share the same wire format — prevents format drift.
 */
export async function writeSSE(
  reply: FastifyReply,
  events: AsyncIterable<unknown>,
): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    for await (const event of events) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    reply.raw.write("data: [DONE]\n\n");
  } catch (err) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
  }
  reply.raw.end();
}
