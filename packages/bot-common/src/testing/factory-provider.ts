/**
 * The structural slice of a Nest factory provider this helper needs. Declared
 * directly rather than intersected with `Provider`, whose union also contains
 * `ClassProvider` and would demand a construct signature a factory has not got.
 */
export type FactoryProvider = {
  provide: unknown;
  useFactory: (...args: unknown[]) => unknown;
  inject?: unknown[];
};

function describeToken(token: unknown): string {
  if (typeof token === 'function') return token.name;
  if (typeof token === 'symbol') return token.description ?? token.toString();
  return String(token);
}

/**
 * Finds a module's factory provider for `token`, with its factory wrapped in an
 * arity check against the provider's own `inject` list.
 *
 * A provider's `inject` is the only declaration of how many arguments its
 * factory receives. Calling that factory with fewer arguments than `inject`
 * lists leaves `undefined` in the tail positions, and because the factory still
 * returns a correctly-shaped object, a spec asserting only the returned type
 * passes. That is how both platform wiring specs went green while the durable
 * attempt store was never handed to the confirmation service.
 *
 * So the count is checked here rather than trusted from the call site: a spec
 * that forgets an argument now fails, and the message names the provider.
 */
export function findFactoryProvider(
  module: object,
  token: unknown,
): FactoryProvider | undefined {
  const providers = (Reflect.getMetadata('providers', module) ??
    []) as unknown[];
  const provider = providers.find(
    (candidate): candidate is FactoryProvider =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'provide' in candidate &&
      candidate.provide === token &&
      'useFactory' in candidate &&
      typeof candidate.useFactory === 'function',
  );
  if (!provider) {
    return undefined;
  }

  const expected = provider.inject?.length ?? 0;
  const factory = provider.useFactory;
  return {
    ...provider,
    useFactory: (...args: unknown[]): unknown => {
      if (args.length !== expected) {
        throw new Error(
          `Provider factory for ${describeToken(token)} declares ${expected} ` +
            `dependenc${expected === 1 ? 'y' : 'ies'} in inject but was called ` +
            `with ${args.length} argument${args.length === 1 ? '' : 's'}. An ` +
            `under-argumented call passes undefined into the tail positions and ` +
            `hides a missing binding, so assert the bound object, not the call.`,
        );
      }
      return factory(...args);
    },
  };
}
