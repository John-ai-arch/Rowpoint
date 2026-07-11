// Worker-thread entry for Monte Carlo regatta simulation. Receives pure data
// (prepared boat descriptors, environment inputs, seed), returns pure data —
// no database handle ever crosses the thread boundary (jobs.runInWorker
// contract). Thousands of race integrations run here so the event loop and
// the HTTP API never stall.
import { parentPort, workerData } from 'node:worker_threads';
import { runRegattaMC } from './monteCarloRegatta.js';

parentPort.postMessage(runRegattaMC(workerData.config));
