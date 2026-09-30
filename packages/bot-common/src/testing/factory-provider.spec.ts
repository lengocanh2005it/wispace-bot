import 'reflect-metadata';
import { findFactoryProvider } from './factory-provider';

const TOKEN = Symbol('SOME_TOKEN');

class Other {
  create(): void {}
}

const moduleWith = (providers: unknown[]) => {
  const target = class {};
  Reflect.defineMetadata('providers', providers, target);
  return target;
};

describe('findFactoryProvider', () => {
  it('returns undefined when the module has no provider for the token', () => {
    const module = moduleWith([{ provide: Other, useFactory: () => ({}) }]);

    expect(findFactoryProvider(module, TOKEN)).toBeUndefined();
  });

  it('calls the factory when the argument count matches inject', () => {
    const module = moduleWith([
      {
        provide: TOKEN,
        useFactory: (a: unknown, b: unknown) => [a, b],
        inject: [Other, Other],
      },
    ]);

    expect(findFactoryProvider(module, TOKEN)!.useFactory(1, 2)).toEqual([
      1, 2,
    ]);
  });

  it('rejects an under-argumented call, which is what hid the binding', () => {
    const module = moduleWith([
      {
        provide: TOKEN,
        useFactory: (a: unknown, b: unknown) => [a, b],
        inject: [Other, Other],
      },
    ]);

    // The old helper handed this straight to the factory: `b` was undefined and
    // the spec still passed, because the returned object had the right type.
    expect(() => findFactoryProvider(module, TOKEN)!.useFactory(1)).toThrow(
      /declares 2 dependencies in inject but was called with 1 argument/,
    );
  });

  it('rejects an over-argumented call rather than silently dropping it', () => {
    const module = moduleWith([
      { provide: TOKEN, useFactory: (a: unknown) => a, inject: [Other] },
    ]);

    expect(() =>
      findFactoryProvider(module, TOKEN)!.useFactory(1, 2, 3),
    ).toThrow(
      /declares 1 dependency in inject but was called with 3 arguments/,
    );
  });

  it('names the provider token so the failure points at one module', () => {
    const module = moduleWith([
      { provide: TOKEN, useFactory: () => ({}), inject: [Other, Other] },
    ]);

    expect(() => findFactoryProvider(module, TOKEN)!.useFactory()).toThrow(
      /Provider factory for SOME_TOKEN/,
    );
  });

  it('treats a provider with no inject list as taking no arguments', () => {
    const module = moduleWith([{ provide: TOKEN, useFactory: () => 'built' }]);

    expect(findFactoryProvider(module, TOKEN)!.useFactory()).toBe('built');
    expect(() => findFactoryProvider(module, TOKEN)!.useFactory(1)).toThrow(
      /declares 0 dependencies in inject but was called with 1 argument/,
    );
  });
});
