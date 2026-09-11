/**
 * Vesta presence plugin, node half. The empty apply gives Loader a host-side
 * row while the browser half ships through `exports["./client"]`.
 */

/** Host plugin body — this package contributes a browser heartbeat only. */
export function apply(): void {}
