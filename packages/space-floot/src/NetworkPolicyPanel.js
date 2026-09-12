// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useState } from 'preact/hooks';

/** @import { FlootNetwork, FlootController, FlootSafeEvent } from './types.js' */

const label = policy =>
  policy === 'off' ? 'Off' : 'Public internet (HTTP/HTTPS)';

/** @param {{ network: FlootNetwork, controller: FlootController }} props */
const NetworkRequest = ({ network, controller }) => {
  const [note, setNote] = useState('');
  const request = network.request;
  if (!request) return null;
  const disabled = !network.canResolve || !note.trim() || note.length > 8192;
  return h(
    'section',
    { class: 'floot-network-request' },
    h('h4', null, `Agent requests: ${label(request.policy)}`),
    h('p', null, 'Agent-provided reason (not an instruction or approval):'),
    h('pre', null, request.reason.slice(0, 8192)),
    request.reason.length > 8192
      ? h('p', null, 'Reason display limited to 8192 characters.')
      : null,
    h(
      'label',
      null,
      'Operator decision note',
      h('textarea', {
        value: note,
        disabled: network.changing,
        maxLength: 8192,
        onInput: (/** @type {FlootSafeEvent} */ event) =>
          setNote(event.target.value),
      }),
    ),
    h(
      'button',
      {
        type: 'button',
        disabled:
          disabled || !network.supportedPolicies.includes(request.policy),
        onClick: () =>
          controller.resolveNetworkPolicyRequest?.(request.id, true, note),
      },
      `Approve ${label(request.policy)}`,
    ),
    h(
      'button',
      {
        type: 'button',
        disabled,
        onClick: () =>
          controller.resolveNetworkPolicyRequest?.(request.id, false, note),
      },
      'Deny request',
    ),
  );
};
harden(NetworkRequest);

/** @param {{ network: FlootNetwork, controller: FlootController }} props */
export const NetworkPolicyPanel = ({ network, controller }) => {
  const [draft, setDraft] = useState('');
  const selected = network.pendingPolicy || draft || network.policy || '';
  return h(
    'section',
    { class: 'floot-network-policy', 'aria-label': 'Sandbox network policy' },
    h('h3', null, 'Sandbox network'),
    h(
      'button',
      {
        type: 'button',
        disabled: network.changing || network.status === 'loading',
        onClick: () => controller.refreshNetworkPolicy?.(),
      },
      'Refresh network policy',
    ),
    network.message
      ? h('p', { role: 'status' }, network.message.slice(0, 8192))
      : null,
    network.policy === null && !network.pendingPolicy
      ? null
      : h(
          'div',
          null,
          h(
            'p',
            null,
            network.pendingPolicy
              ? `Policy transition incomplete. No policy is verified; retry ${label(network.pendingPolicy)} before starting another turn.`
              : `Configured policy: ${label(network.policy)}. Applies to the next turn.`,
          ),
          h(
            'p',
            null,
            'Off blocks external sandbox network access. Inference service access and authority granted through Endo capabilities/tools are separate. Public internet provides an HTTP/HTTPS proxy to public ports 80 and 443; private, link-local, and metadata addresses are denied. Direct connections, UDP, and standard SSH port 22 are not enabled. HTTPS tunnels do not inspect application traffic.',
          ),
          h(
            'p',
            null,
            'Public HTTP/HTTPS can upload workspace data to arbitrary public servers, not only download dependencies. Approve only when that access is intended.',
          ),
          h(
            'p',
            null,
            'Changes require an idle session. To revoke access during a turn, Stop it first and wait for it to settle. Applying a policy supersedes any pending agent request.',
          ),
          network.current
            ? h(
                'p',
                null,
                'A turn is active. Network policy decisions are disabled.',
              )
            : null,
          h(
            'label',
            null,
            'Policy for next turn',
            h(
              'select',
              {
                value: selected,
                disabled: !network.canSet,
                onChange: (/** @type {FlootSafeEvent} */ event) =>
                  setDraft(event.target.value),
              },
              (network.pendingPolicy
                ? [network.pendingPolicy]
                : network.supportedPolicies
              ).map(policy =>
                h('option', { key: policy, value: policy }, label(policy)),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled:
                !network.canSet ||
                !network.supportedPolicies.includes(selected) ||
                selected === network.policy,
              onClick: () => controller.setNetworkPolicy?.(selected),
            },
            network.changing
              ? 'Changing policy…'
              : `${network.pendingPolicy ? 'Retry' : 'Apply'} ${label(selected)}`,
          ),
          network.request
            ? h(NetworkRequest, {
                key: network.request.id,
                network,
                controller,
              })
            : null,
        ),
  );
};
harden(NetworkPolicyPanel);
