// @ts-check

// Session adapters use the same acquisition/cleanup registry as runtime drivers.
export { makeResourceRegistry as makeSessionRegistry } from '@endo/sandbox/resource-registry.js';
