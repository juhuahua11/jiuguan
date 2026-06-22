/**
 * Session-level monotonic version counter for optimistic locking.
 * Prevents stale Worker tasks from overwriting newer data.
 */

const versionMap = new Map<string, number>();

export function nextVersion(sessionId: string): number {
  const current = versionMap.get(sessionId) || 0;
  const next = current + 1;
  versionMap.set(sessionId, next);
  return next;
}

export function getCurrentVersion(sessionId: string): number {
  return versionMap.get(sessionId) || 0;
}

export function isStaleVersion(sessionId: string, taskVersion: number): boolean {
  return taskVersion < getCurrentVersion(sessionId);
}

export function resetVersion(sessionId: string): void {
  versionMap.delete(sessionId);
}
