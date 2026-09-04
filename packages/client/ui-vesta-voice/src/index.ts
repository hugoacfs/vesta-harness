/**
 * Vesta voice surface, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`; the Host side of
 * a call is `@deepseek-ai/dsh-vesta-voice`.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
