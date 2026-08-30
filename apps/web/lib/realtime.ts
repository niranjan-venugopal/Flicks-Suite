/**
 * Shared socket.io client settings for the four real-time namespaces
 * (/presence, /notifications, /crm, /sync).
 *
 * Transport order matters. Every connection used to be opened with
 * `['websocket', 'polling']`, i.e. attempt a raw WebSocket first. When
 * anything between the browser and the API declines to forward the
 * `Upgrade: websocket` header — a load balancer, a CDN, a corporate proxy —
 * that attempt fails outright and the browser logs
 *
 *   WebSocket connection to 'wss://…/socket.io/?EIO=4&transport=websocket'
 *   failed: WebSocket is closed before the connection is established.
 *
 * once per reconnect, forever. `['polling', 'websocket']` is socket.io's own
 * default: it completes the handshake over ordinary HTTP (the same path the
 * REST API already takes, so it works wherever the app works) and *then*
 * silently upgrades to a WebSocket. Where the upgrade succeeds nothing
 * changes; where it is blocked, real-time keeps working over long-polling
 * instead of failing loudly.
 */
// Not `as const`: socket.io's ManagerOptions types `transports` as a MUTABLE
// string[], so a readonly tuple is rejected at every call site.
export const SOCKET_TRANSPORTS: string[] = ['polling', 'websocket']
