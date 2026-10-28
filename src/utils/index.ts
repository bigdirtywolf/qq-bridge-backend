/** Node 18+ 内置 WebSocket（本项目不额外引入 ws 依赖）。 */
export function requireWebSocket(): any {
    const impl = (globalThis as any).WebSocket;
    if (!impl) throw new Error('当前 Node 没有内置 WebSocket，请使用 Node 22 及以上版本');
    return impl;
}
