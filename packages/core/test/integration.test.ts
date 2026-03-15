import { createProbePair } from "../src";

type Dep = {
  request(input: { siteId: number }): Promise<{ ok: boolean }>;
};

async function callWithTimeout(dep: Dep, timeoutMs: number): Promise<{ ok: boolean }> {
  return Promise.race([
    dep.request({ siteId: 1 }),
    new Promise<{ ok: boolean }>((_resolve, reject) => {
      setTimeout(() => reject(new Error("call has been timed out")), timeoutMs);
    }),
  ]);
}

async function callWithRetry(dep: Dep, retryDelayMs: number): Promise<{ ok: boolean }> {
  try {
    return await dep.request({ siteId: 1 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return dep.request({ siteId: 1 });
  }
}

describe("integration: probes + fake timers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("times out when downstream call is not answered", async () => {
    const { fake: dep, probe } = createProbePair<Dep>();

    const resultPromise = callWithTimeout(dep, 30_000);

    const call = await probe.expectNext();
    expect(call.method).toBe("request");
    expect(call.args).toEqual([{ siteId: 1 }]);

    jest.advanceTimersByTime(30_000);
    await expect(resultPromise).rejects.toThrow("call has been timed out");
  });

  it("retries after first failure and succeeds on second response", async () => {
    const { fake: dep, probe } = createProbePair<Dep>();

    const resultPromise = callWithRetry(dep, 2_000);

    const firstCall = await probe.expectNext();
    firstCall.reject(new Error("temporary failure"));
    await Promise.resolve();

    jest.advanceTimersByTime(2_000);

    const secondCall = await probe.expectNext();
    secondCall.answer({ ok: true });

    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  it("multiple concurrent calls answered out of order", async () => {
    const { fake: dep, probe } = createProbePair<Dep>();

    const p1 = dep.request({ siteId: 1 });
    const p2 = dep.request({ siteId: 2 });

    const call2 = await probe.expectMatching((c) => (c.args[0] as any).siteId === 2);
    const call1 = await probe.expectMatching((c) => (c.args[0] as any).siteId === 1);

    call2.answer({ ok: true });
    call1.answer({ ok: false });

    await expect(p1).resolves.toEqual({ ok: false });
    await expect(p2).resolves.toEqual({ ok: true });
  });
});
