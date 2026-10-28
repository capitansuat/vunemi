import type { CoordinatorStatus } from '../shared/ipc.js';

type Metric = { pid: number; type: string; name?: string; creationTime: number };
const roles = new Map<string, CoordinatorStatus['workers'][number]['role']>([
  ['Vunemi Agent Session', 'session'],
  ['Vunemi Native Execution', 'native'],
  ['Vunemi Vault', 'vault'],
]);

/** Read-only projection. Never expose arbitrary process metrics or command data. */
export function coordinatorStatus(mainPid: number, metrics: readonly Metric[]): CoordinatorStatus {
  const unavailable = () => { throw Error('Coordinator diagnostics unavailable.'); };
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0 || !Array.isArray(metrics)) return unavailable();
  const workers: CoordinatorStatus['workers'] = [];
  const seenRoles = new Set<string>(), seenPids = new Set<number>();
  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') return unavailable();
    const role = roles.get(metric.name ?? '');
    if (metric.type !== 'Utility' || !role) continue;
    if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0 || metric.pid === mainPid ||
        !Number.isFinite(metric.creationTime) || metric.creationTime <= 0 ||
        seenRoles.has(role) || seenPids.has(metric.pid)) return unavailable();
    seenRoles.add(role); seenPids.add(metric.pid);
    workers.push({ role, pid: metric.pid, startedAt: metric.creationTime });
  }
  return { mainPid, workers };
}
