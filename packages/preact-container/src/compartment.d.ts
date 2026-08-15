import { ComponentChildren, FunctionComponent } from 'preact';

/**
 * Bundle of utilities handed to the attacker function as its first
 * argument. The attacker can use these to produce vnodes and manage
 * component state; they cannot reach the DOM through them.
 */
export interface CompartmentEndowments {
  h: typeof import('preact').h;
  Fragment: typeof import('preact').Fragment;
  useState: typeof import('preact/hooks').useState;
  useEffect: typeof import('preact/hooks').useEffect;
  useCallback: typeof import('preact/hooks').useCallback;
  useMemo: typeof import('preact/hooks').useMemo;
  useRef: typeof import('preact/hooks').useRef;
  useReducer: typeof import('preact/hooks').useReducer;
}

/**
 * Shape of the props the attacker sees. The host's `children`, if any,
 * is replaced with an array of opaque sentinel vnodes the attacker can
 * position but not inspect. When the host renders the component with no
 * children, `children` is `undefined`.
 *
 * SECURITY: any function-typed prop the host passes through (e.g. an
 * `onSubmit` callback) is callable by the attacker with arbitrary
 * arguments. Host code MUST treat those arguments as untrusted JSON.
 */
export type ConfinedProps<P extends object = {}> = Readonly<
  Omit<P, 'children'>
> & {
  readonly children?: readonly unknown[] | undefined;
};

export interface ConfineOptions {
  /** Display name used by devtools. Default: `"Confined"`. */
  name?: string;
  /**
   * Called when the attacker function throws during render. The
   * confined component renders nothing on that pass; the host render
   * is not disrupted. Useful for telemetry. Exceptions from
   * `onError` itself are swallowed.
   */
  onError?: (error: unknown) => void;
}

/**
 * Wrap an attacker-supplied component function so it can be mounted in
 * a normal Preact tree. Place the result inside a `renderConfined` tree
 * to get full sanitization on top.
 */
export function confineComponent<P extends object = {}>(
  fn: (endowments: CompartmentEndowments, props: ConfinedProps<P>) => unknown,
  opts?: ConfineOptions,
): FunctionComponent<Omit<P, 'children'> & { children?: ComponentChildren }>;

/** Returns true if `value` is a wrapper returned by `confineComponent`. */
export function isConfinedComponent(value: unknown): boolean;

/**
 * Mint a sealed, parameterized component a confined child can PLACE but never inspect, invoke for a
 * value, or parameterize beyond the declared params (see the "TRUSTED-IN-UNTRUSTED" comment above
 * `sealComponent` in compartment.js for the four properties this enforces). `hostFn` runs with HOST
 * authority and receives only the declared, coerced params — never the child's raw props, and never
 * child-supplied functions or objects.
 */
export function sealComponent(
  hostFn: (
    params: Readonly<Record<string, string | number | boolean | bigint>>,
  ) => unknown,
  opts?: { params?: string[] },
): FunctionComponent<any>;

/** True iff `value` is a placeholder minted by `sealComponent` (identity, never a flag). */
export function isSealedComponent(value: unknown): boolean;

export { HostPassthrough } from './renderer.js';
