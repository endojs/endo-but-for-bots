// @ts-check

import { M } from '@endo/patterns';

/* eslint-disable @endo/no-harden-pattern-maker */

export const ChildAgentPolicyShape = M.splitRecord(
  {},
  {
    maxChildren: M.number(),
    maxInstructionBytes: M.number(),
    endowmentNames: M.arrayOf(M.string()),
  },
);
harden(ChildAgentPolicyShape);

export const CreateOptionsShape = M.splitRecord(
  {},
  {
    instructions: M.string(),
    endowments: M.recordOf(M.string(), M.any()),
  },
);
harden(CreateOptionsShape);

export const ChildAgentSummaryShape = harden({
  name: M.string(),
  phase: M.string(),
  createdAt: M.number(),
  operationId: M.string(),
});

export const DerivedNamespaceSummaryShape = harden({
  name: M.string(),
  phase: M.string(),
  retainedChildren: M.number(),
});

/**
 * The trusted host-side adapter contract. A maker installs the loop that
 * answers a child's mail and returns the durable responder whose incarnation
 * starts or rejoins that loop. It is never exposed to the child.
 */
export const AgentDriverMakerInterface = M.interface('AgentDriverMaker', {
  installDriver: M.callWhen(
    M.splitRecord(
      {
        agent: M.remotable(),
        driverGuest: M.remotable(),
        lifecycle: M.remotable('AgentLifecycle'),
      },
      { instructions: M.string() },
    ),
  ).returns(M.splitRecord({ responder: M.any() })),
});
harden(AgentDriverMakerInterface);

/** The root facet. Only the deploying host holds it. */
export const ChildAgentFactoryInterface = M.interface('ChildAgentFactory', {
  bind: M.callWhen(M.remotable('AgentDriverMaker'))
    .optional(ChildAgentPolicyShape)
    .returns(M.remotable('BoundChildAgentFactory')),
  listDerived: M.callWhen().returns(M.arrayOf(DerivedNamespaceSummaryShape)),
  revokeDerived: M.callWhen(M.string()).returns(M.undefined()),
});
harden(ChildAgentFactoryInterface);

export const BoundChildAgentFactoryInterface = M.interface(
  'BoundChildAgentFactory',
  {
    create: M.callWhen(M.string())
      .optional(CreateOptionsShape)
      .returns(
        harden({ summary: ChildAgentSummaryShape, handle: M.remotable() }),
      ),
    lookup: M.callWhen(M.string()).returns(M.remotable()),
    list: M.callWhen().returns(M.arrayOf(ChildAgentSummaryShape)),
    remove: M.callWhen(M.string()).returns(M.undefined()),
    attenuate: M.callWhen(M.string(), ChildAgentPolicyShape).returns(
      M.remotable('BoundChildAgentFactory'),
    ),
    listDerived: M.callWhen().returns(M.arrayOf(DerivedNamespaceSummaryShape)),
    revokeDerived: M.callWhen(M.string()).returns(M.undefined()),
  },
);
harden(BoundChildAgentFactoryInterface);

/** A read-only view of one child's operation state, given to its runner. */
export const AgentLifecycleInterface = M.interface('AgentLifecycle', {
  isActive: M.call().returns(M.boolean()),
  followActive: M.call().returns(M.remotable('ActiveIterator')),
});
harden(AgentLifecycleInterface);

/**
 * The coordinator's own facet, held only in the factory's private directory.
 * It is the sole endowment of each durable facet formula, which re-derives
 * a bound factory or a child's lifecycle from the live incarnation on
 * revival. The ids it accepts are coordinator labels, never authority.
 */
export const ChildAgentCoordinatorInterface = M.interface(
  'ChildAgentCoordinator',
  {
    boundFacet: M.call(M.number()).returns(
      M.remotable('BoundChildAgentFactory'),
    ),
    lifecycleFor: M.call(M.string()).returns(M.remotable('AgentLifecycle')),
  },
);
harden(ChildAgentCoordinatorInterface);
