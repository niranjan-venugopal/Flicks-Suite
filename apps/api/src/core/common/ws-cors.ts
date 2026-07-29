/**
 * Shared socket.io CORS config for every WebSocket gateway.
 *
 * The @WebSocketGateway decorator evaluates at class-definition time — before
 * Nest's ConfigService exists — so a static allow-list can't be injected.
 * socket.io accepts a per-handshake `origin` FUNCTION, which lets us read
 * CORS_ORIGINS from process.env lazily on every connection instead. This
 * keeps the HTTP CORS allow-list and the WS allow-list driven by the SAME
 * env var (main.ts parses the same variable for Express).
 *
 * Origin-less handshakes (server-to-server tools, some native clients) are
 * allowed through — same posture as the HTTP layer, where a missing Origin
 * header skips CORS entirely. Auth still gates every connection.
 */
export function wsCors() {
  return {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      const allowed = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(new Error('Origin not allowed by CORS_ORIGINS'));
    },
    credentials: true,
  };
}
