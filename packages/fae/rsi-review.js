// @ts-check
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const Proposal = harden({
  repo: M.or(M.eq('endo'), M.eq('endo-host')),
  number: M.number(),
  head: M.string(),
  title: M.string(),
  summary: M.string(),
});
const Interface = M.interface('Reviewed pull requests', {
  propose: M.callWhen(Proposal).returns(M.record()),
  help: M.call().returns(M.string()),
});

/** @param {any} directory */
export const make = directory =>
  makeExo('Reviewed pull requests', Interface, {
    async propose({ repo, number, head, title, summary }) {
      if (
        (repo !== 'endo' && repo !== 'endo-host') ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        !/^[a-f0-9]{40}$/.test(head) ||
        !title.trim() ||
        title.length > 250 ||
        !summary.trim() ||
        summary.length > 8000
      )
        throw Error('Invalid pull request proposal');
      const { broker, service, factories } =
        await E(directory).lookup('settings');
      const pr = await E(broker).verify(repo, number, head);
      if (
        pr.repo !== repo ||
        pr.number !== number ||
        pr.head !== head ||
        !/^[a-f0-9]{40}$/.test(pr.base)
      )
        throw Error('Verified pull request identity changed');
      const files =
        repo === 'endo-host' ? await E(broker).reviewFiles(number, head) : [];
      const factory = await E(service).factory(factories[repo]);
      const { runId } = await E(factory).start(
        harden({
          requestId: `pr-${number}-${head}`,
          params: {
            title,
            summary: `Pull request: ${pr.url}\n${summary}`,
            base: pr.base,
            head,
            files,
          },
        }),
      );
      return harden({ runId });
    },
    help: () =>
      'propose({repo,number,head,title,summary}) verifies an open Tokyo Forgejo pull request, submits its immutable revision for independent code review, and returns {runId}. Accepted changes go to the operator for deployment approval.',
  });
harden(make);
