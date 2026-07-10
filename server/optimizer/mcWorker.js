// Worker-thread entry for Monte Carlo plan evaluation. Receives pure data,
// returns pure data — no database handle ever crosses the thread boundary
// (jobs.runInWorker contract). Heavy loops run here so the event loop and
// the HTTP API never stall.
import { parentPort, workerData } from 'node:worker_threads';
import { evaluatePlansMC } from './monteCarlo.js';

const { plans, athlete, opts } = workerData;
parentPort.postMessage(evaluatePlansMC(plans, athlete, opts));
