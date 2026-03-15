import { getProbeController } from "./probe";

type MethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];

type MethodFn<T, K extends keyof T> = T[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;
type MethodArgs<T, K extends keyof T> = Parameters<MethodFn<T, K>>;
type MethodReturn<T, K extends keyof T> = Awaited<ReturnType<MethodFn<T, K>>>;

export function whenCalled<T extends object, K extends MethodKeys<T>>(fake: T, method: K) {
  const controller = getProbeController(fake as object);
  const methodName = String(method);

  return {
    thenReturn(value: MethodReturn<T, K>) {
      controller.planBehavior(methodName, { type: "return", value });
      return fake;
    },
    thenReject(error: unknown) {
      controller.planBehavior(methodName, { type: "reject", error });
      return fake;
    },
    thenCall(fn: (...args: MethodArgs<T, K>) => MethodReturn<T, K> | Promise<MethodReturn<T, K>>) {
      controller.planBehavior(methodName, {
        type: "call",
        fn: (...args) => fn(...(args as MethodArgs<T, K>)),
      });
      return fake;
    },
  };
}

export function alwaysReturn<T extends object, K extends MethodKeys<T>>(
  fake: T,
  method: K,
  value: MethodReturn<T, K>,
): void {
  const controller = getProbeController(fake as object);
  controller.planPermanentBehavior(String(method), { type: "return", value });
}

export function alwaysReject<T extends object, K extends MethodKeys<T>>(
  fake: T,
  method: K,
  error: unknown,
): void {
  const controller = getProbeController(fake as object);
  controller.planPermanentBehavior(String(method), { type: "reject", error });
}

export function alwaysCall<T extends object, K extends MethodKeys<T>>(
  fake: T,
  method: K,
  fn: (...args: MethodArgs<T, K>) => MethodReturn<T, K> | Promise<MethodReturn<T, K>>,
): void {
  const controller = getProbeController(fake as object);
  controller.planPermanentBehavior(String(method), {
    type: "call",
    fn: (...args) => fn(...(args as MethodArgs<T, K>)),
  });
}
