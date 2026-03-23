/**
 * src/state.js
 * Estado compartido en memoria entre patrol.js, dm.js y mentions.js.
 * Reset natural en cada reinicio del proceso.
 */

/** Hilos (root URIs) donde algún usuario pidió que el bot no intervenga */
export const optedOut = new Set();

/** Hilos donde el patrullero ya publicó una alerta (evita repetición) */
export const intervenedThreads = new Set();

/** Timestamp (ms) de la última intervención del patrullero */
let _lastPatrolIntervention = 0;

export function getLastPatrolIntervention() {
  return _lastPatrolIntervention;
}

export function setLastPatrolIntervention(ts) {
  _lastPatrolIntervention = ts;
}
