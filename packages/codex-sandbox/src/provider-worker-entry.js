// @ts-check
// The shared worker initializes SES before the listener modules evaluate.
import { startProviderListenerWorker } from '@endo/hosted-agent/provider-worker.js';
import { Fail } from '@endo/errors';
import process from 'node:process';

import { makePublicDnsListener } from './public-dns-listener.js';
import { makePublicEgressListener } from './public-egress-listener.js';

await startProviderListenerWorker({
  input: process.stdin,
  output: process.stdout,
  async makeNetworkListeners({ endpoint, address }) {
    typeof address === 'string' || Fail`Missing public proxy address`;
    const dns = await makePublicDnsListener({ endpoint });
    let proxy;
    try {
      proxy = await makePublicEgressListener({ endpoint, host: address });
    } catch (error) {
      await dns.dispose();
      throw error;
    }
    return harden({
      evidence: {
        policy: 'public-internet',
        proxyUrl: proxy.url,
        dnsHost: dns.host,
      },
      async dispose() {
        await Promise.all([proxy.dispose(), dns.dispose()]);
      },
    });
  },
});
