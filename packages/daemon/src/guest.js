// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { q } from '@endo/errors';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import {
  cancelPendingIterator,
  mapCancelableIterator,
} from './cancelable-iterator.js';
import { makePetSitter } from './pet-sitter.js';
import {
  assertPetNamePath,
  namePathFrom,
  petNamePathFrom,
} from './pet-name.js';
import { makeDeferredTasks } from './deferred-tasks.js';

/** @import { Context, ContentLoadable, DaemonCore, DeferredTasks, EndoGuest, EndoGuestDirectory, EvalDeferredTaskParams, GuestMessage, FormulaIdentifier, MakeDirectoryNode, MakeMailbox, MarshalDeferredTaskParams, Name, NameOrPath, NamePath, NodeNumber, NamesOrPaths, Provide, ReadableBlobDeferredTaskParams, WorkerDeferredTaskParams } from './types.js' */
import { GuestInterface } from './interfaces.js';
import { guestHelp, makeHelp } from './help-text.js';
import { registerGuestDirectory } from './guest-amplification.js';
import { makeMessageRedactor, redactNameChange } from './guest-redaction.js';
import { guestFacetFor, unwrapGuestFacet } from './directory.js';

/**
 * @param {object} args
 * @param {Provide} args.provide
 * @param {DaemonCore['provideStoreController']} args.provideStoreController
 * @param {DaemonCore['formulateEval']} args.formulateEval
 * @param {DaemonCore['formulateReadableBlob']} args.formulateReadableBlob
 * @param {DaemonCore['formulateMarshalValue']} args.formulateMarshalValue
 * @param {DaemonCore['getFormulaForId']} args.getFormulaForId
 * @param {DaemonCore['getAllNetworkAddresses']} args.getAllNetworkAddresses
 * @param {DaemonCore['getAllContentSources']} args.getAllContentSources
 * @param {ContentLoadable['loadContent']} args.loadContent
 * @param {MakeMailbox} args.makeMailbox
 * @param {MakeDirectoryNode} args.makeDirectoryNode
 * @param {(node: string) => boolean} args.isLocalKey
 * @param {DaemonCore['pinTransient']} [args.pinTransient]
 * @param {DaemonCore['unpinTransient']} [args.unpinTransient]
 */
export const makeGuestMaker = ({
  provide,
  provideStoreController,
  formulateEval,
  formulateReadableBlob,
  formulateMarshalValue,
  getFormulaForId,
  getAllNetworkAddresses,
  getAllContentSources,
  loadContent,
  makeMailbox,
  makeDirectoryNode,
  isLocalKey,
  pinTransient = /** @param {any} _id */ _id => {},
  unpinTransient = /** @param {any} _id */ _id => {},
}) => {
  /**
   * @param {FormulaIdentifier} guestId
   * @param {FormulaIdentifier} handleId
   * @param {NodeNumber} agentNodeNumber
   * @param {FormulaIdentifier} hostAgentId
   * @param {FormulaIdentifier} hostHandleId
   * @param {FormulaIdentifier} petStoreId
   * @param {FormulaIdentifier} mailboxStoreId
   * @param {FormulaIdentifier | undefined} mailHubId
   * @param {FormulaIdentifier} mainWorkerId
   * @param {FormulaIdentifier} networksDirectoryId
   * @param {FormulaIdentifier} planesDirectoryId
   * @param {FormulaIdentifier | undefined} guestPinsDirectoryId
   * @param {FormulaIdentifier | undefined} hostPinsDirectoryId
   * @param {Context} context
   */
  const makeGuest = async (
    guestId,
    handleId,
    agentNodeNumber,
    hostAgentId,
    hostHandleId,
    petStoreId,
    mailboxStoreId,
    mailHubId,
    mainWorkerId,
    networksDirectoryId,
    planesDirectoryId,
    guestPinsDirectoryId,
    hostPinsDirectoryId,
    context,
  ) => {
    context.thisDiesIfThatDies(hostHandleId);
    context.thisDiesIfThatDies(hostAgentId);
    context.thisDiesIfThatDies(petStoreId);
    context.thisDiesIfThatDies(mailboxStoreId);
    if (mailHubId !== undefined) {
      context.thisDiesIfThatDies(mailHubId);
    }
    context.thisDiesIfThatDies(mainWorkerId);
    context.thisDiesIfThatDies(networksDirectoryId);
    context.thisDiesIfThatDies(planesDirectoryId);
    if (guestPinsDirectoryId !== undefined) {
      context.thisDiesIfThatDies(guestPinsDirectoryId);
    }
    if (hostPinsDirectoryId !== undefined) {
      context.thisDiesIfThatDies(hostPinsDirectoryId);
    }

    const baseController = await provideStoreController(petStoreId);
    const mailboxController = await provideStoreController(mailboxStoreId);
    const specialNames = {
      '@agent': guestId,
      '@self': handleId,
      '@host': hostHandleId,
    };
    if (mailHubId !== undefined) {
      specialNames['@mail'] = mailHubId;
    }
    specialNames['@nets'] = networksDirectoryId;
    specialNames['@planes'] = planesDirectoryId;
    // The guest-visible pin directory is distinct from the host-only pin
    // directory, which is deliberately absent from special names.
    if (guestPinsDirectoryId !== undefined) {
      specialNames['@pins'] = guestPinsDirectoryId;
    }
    const specialStore = makePetSitter(baseController, specialNames);

    const getNetworkAddresses = () =>
      getAllNetworkAddresses(networksDirectoryId);
    const getContentSources = identity =>
      getAllContentSources(planesDirectoryId, identity);
    const directory = makeDirectoryNode(
      specialStore,
      agentNodeNumber,
      isLocalKey,
      getNetworkAddresses,
      getContentSources,
    );
    const mailbox = await makeMailbox({
      petStore: specialStore,
      agentNodeNumber,
      mailboxStore: mailboxController,
      directory,
      selfId: handleId,
      context,
    });
    const { handle } = mailbox;

    const {
      has,
      list,
      listValues: directoryListValues,
      locateContent,
      listContent,
      storeContent,
      reverseLocateContent,
      internalizeContentLocator,
      followNameChanges: directoryFollowNameChanges,
      lookup: directoryLookup,
      maybeLookup: directoryMaybeLookup,
      reverseLookup: directoryReverseLookup,
      guestReadText: directoryReadText,
      guestMaybeReadText: directoryMaybeReadText,
      guestWriteText: directoryWriteText,
      guestMove: move,
      guestRemove: remove,
      guestCopy: copy,
      makeDirectory: directoryMakeDirectory,
    } = directory;

    const {
      listMessages: mailboxListMessages,
      followMessages: mailboxFollowMessages,
      messageHistory: mailboxMessageHistory,
      resolve,
      reject,
      adopt,
      dismiss,
      dismissAll,
      reply,
      request: mailboxRequest,
      send,
      editMessage,
      define: mailboxDefine,
      form: mailboxForm,
      submit: mailboxSubmit,
      sendValue: mailboxSendValue,
    } = mailbox;

    const { redactMessage } = makeMessageRedactor(id =>
      specialStore.reverseIdentify(id),
    );

    /** @type {EndoGuest['listMessages']} */
    const listMessages = async () =>
      harden((await mailboxListMessages()).map(redactMessage));

    /** @type {EndoGuest['followMessages']} */
    const followMessages = () =>
      mapCancelableIterator(mailboxFollowMessages(), redactMessage);

    /** @type {EndoGuest['messageHistory']} */
    const messageHistory = async messageNumber =>
      harden(
        (await mailboxMessageHistory(messageNumber)).map(revision =>
          harden({ ...revision, envelope: redactMessage(revision.envelope) }),
        ),
      );

    /** @type {EndoGuest['followNameChanges']} */
    const followNameChanges = () =>
      mapCancelableIterator(directoryFollowNameChanges(), redactNameChange);

    // A directory reaches a guest only as its pet-name facet, which carries no
    // identifier or locator methods: otherwise a guest could make or look up a
    // directory, copy a value into it, and `identify` or `locate` it there.
    /** @type {EndoGuest['lookup']} */
    const lookup = async petNamePath =>
      guestFacetFor(await directoryLookup(petNamePath));

    /** @type {EndoGuest['maybeLookup']} */
    const maybeLookup = async petNamePath =>
      guestFacetFor(await directoryMaybeLookup(petNamePath));

    // The snapshot holds a promise per name; narrow each as it settles.
    /** @type {EndoGuest['listValues']} */
    const listValues = async () =>
      harden(
        (await directoryListValues()).map(value =>
          Promise.resolve(value).then(guestFacetFor),
        ),
      );

    /** @type {EndoGuest['reverseLookup']} */
    const reverseLookup = value =>
      directoryReverseLookup(unwrapGuestFacet(value));

    // A correspondent resolves a request with any value it names, which may
    // be a directory; it too reaches the guest as its pet-name facet.
    /** @type {EndoGuest['request']} */
    const request = async (toNameOrPath, description, responseName) =>
      guestFacetFor(
        await mailboxRequest(toNameOrPath, description, responseName),
      );

    /** @type {EndoGuest['makeDirectory']} */
    const makeDirectory = async petNamePath =>
      /** @type {EndoGuestDirectory} */ (
        guestFacetFor(await directoryMakeDirectory(petNamePath))
      );

    /**
     * @param {NameOrPath | undefined} workerName
     * @param {DeferredTasks<WorkerDeferredTaskParams>['push']} deferTask
     */
    const prepareWorkerFormulation = async (workerName, deferTask) => {
      if (workerName === undefined) {
        return undefined;
      }
      const workerNamePath = namePathFrom(workerName);
      // A single segment resolves against the guest's own pet store; a
      // path resolves through the directory.
      const workerId = /** @type {FormulaIdentifier | undefined} */ (
        workerNamePath.length === 1
          ? specialStore.identifyLocal(workerNamePath[0])
          : await E(directory).identify(...workerNamePath)
      );
      if (workerId === undefined) {
        const { namePath, petName } = assertPetNamePath(workerNamePath);
        deferTask(identifiers =>
          namePath.length === 1
            ? specialStore.storeIdentifier(petName, identifiers.workerId)
            : E(directory).storeIdentifier(namePath, identifiers.workerId),
        );
        return undefined;
      }
      return workerId;
    };

    /**
     * Evaluate code directly in a worker, constrained only by reachable
     * capabilities in the guest's namespace.
     * @param {NameOrPath | undefined} workerName
     * @param {string} source
     * @param {Array<string>} codeNames
     * @param {NamesOrPaths} petNamesOrPaths
     * @param {NameOrPath} [resultName]
     * @returns {Promise<unknown>}
     */
    const evaluate = async (
      workerName,
      source,
      codeNames,
      petNamesOrPaths,
      resultName,
    ) => {
      if (!Array.isArray(codeNames)) {
        throw new Error('Evaluator requires an array of code names');
      }
      for (const codeName of codeNames) {
        if (typeof codeName !== 'string') {
          throw new Error(`Invalid endowment name: ${q(codeName)}`);
        }
      }
      if (petNamesOrPaths.length !== codeNames.length) {
        throw new Error('Evaluator requires one pet name for each code name');
      }

      /** @type {DeferredTasks<EvalDeferredTaskParams>} */
      const tasks = makeDeferredTasks();

      const workerId = await prepareWorkerFormulation(workerName, tasks.push);

      // Every endowment, even a single name, resolves by a lookup through
      // this guest, never by formula identifier, so a directory arrives as
      // its pet-name facet as from the guest's own `lookup`. A raw identifier
      // would hand the evaluated code the full directory, with `identify`,
      // `locate`, and `storeIdentifier`.
      /** @type {NamePath[]} */
      const endowmentPaths = petNamesOrPaths.map(petNameOrPath => {
        const petNamePath = namePathFrom(petNameOrPath);
        if (
          petNamePath.length === 1 &&
          specialStore.identifyLocal(petNamePath[0]) === undefined
        ) {
          throw new Error(`Unknown pet name ${q(petNamePath[0])}`);
        }
        return petNamePath;
      });

      if (resultName !== undefined) {
        const { namePath: resultNamePath } = petNamePathFrom(resultName);
        tasks.push(identifiers =>
          E(directory).storeIdentifier(resultNamePath, identifiers.evalId),
        );
      }

      const { id, value } = await formulateEval(
        guestId,
        source,
        codeNames,
        endowmentPaths,
        tasks,
        workerId,
        resultName === undefined ? pinTransient : undefined,
      );
      if (resultName === undefined) {
        try {
          return await value;
        } finally {
          await unpinTransient(id);
        }
      }
      return value;
    };

    /** @type {EndoGuest['define']} */
    const define = (source, slots) => mailboxDefine(source, slots);

    /** @type {EndoGuest['form']} */
    const form = (recipientName, description, fields) =>
      mailboxForm(recipientName, description, fields);

    /** @type {EndoGuest['submit']} */
    const submit = (messageNumber, values) =>
      mailboxSubmit(messageNumber, values);

    /** @type {EndoGuest['sendValue']} */
    const sendValue = (messageNumber, petNameOrPath) =>
      mailboxSendValue(messageNumber, petNameOrPath);

    /** @type {EndoGuest['storeBlob']} */
    const storeBlob = async (readerRef, petName) => {
      if (petName === undefined) {
        throw new TypeError('storeBlob requires a pet name');
      }
      const { namePath } = petNamePathFrom(petName);

      /** @type {DeferredTasks<ReadableBlobDeferredTaskParams>} */
      const tasks = makeDeferredTasks();
      tasks.push(identifiers =>
        E(directory).storeIdentifier(namePath, identifiers.readableBlobId),
      );

      const { value: blob } = await formulateReadableBlob(readerRef, tasks);
      return blob;
    };

    /** @type {EndoGuest['storeValue']} */
    const storeValue = async (value, petName) => {
      const { namePath } = petNamePathFrom(petName);
      /** @type {DeferredTasks<MarshalDeferredTaskParams>} */
      const tasks = makeDeferredTasks();
      tasks.push(identifiers =>
        E(directory).storeIdentifier(namePath, identifiers.marshalId),
      );
      const { id } = await formulateMarshalValue(value, tasks, pinTransient);
      await unpinTransient(id);
    };

    /** @type {EndoGuest} */
    const guest = {
      // Directory
      has,
      list,
      listValues,
      locateContent,
      listContent,
      storeContent,
      reverseLocateContent,
      internalizeContentLocator,
      loadContent,
      followNameChanges,
      lookup,
      maybeLookup,
      reverseLookup,
      move,
      remove,
      copy,
      makeDirectory,
      readText: directoryReadText,
      maybeReadText: directoryMaybeReadText,
      writeText: directoryWriteText,
      // Mail
      handle,
      listMessages,
      followMessages,
      resolve,
      reject,
      adopt,
      dismiss,
      dismissAll,
      reply,
      request,
      send,
      editMessage,
      messageHistory,
      evaluate,
      // Define/Form
      define,
      form,
      storeBlob,
      storeValue,
      submit,
      sendValue,
    };

    const guestExo = makeExo(
      'EndoGuest',
      GuestInterface,
      /** @type {any} */ ({
        help: makeHelp(guestHelp),
        ...guest,
        followMessages: async () => {
          const iterator = guest.followMessages();
          return readerFromIterator(/** @type {any} */ (iterator), {
            cancelPending: () => cancelPendingIterator(iterator),
          });
        },
        followNameChanges: async () => {
          const iterator = guest.followNameChanges();
          return readerFromIterator(iterator, {
            cancelPending: () => cancelPendingIterator(iterator),
          });
        },
      }),
    );
    registerGuestDirectory(guestExo, directory);
    return guestExo;
  };

  return makeGuest;
};
