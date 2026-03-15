import { createProbePair, whenCalled, alwaysReturn, alwaysReject, alwaysCall } from "../src";

type DemoService = {
  getById(id: number): Promise<{ id: number }>;
  getName(id: number): Promise<string>;
};

describe("whenCalled (one-shot porcelain)", () => {
  it("thenReturn() auto-resolves the next call", async () => {
    const { fake } = createProbePair<DemoService>();
    whenCalled(fake, "getName").thenReturn("gilad");
    await expect(fake.getName(1)).resolves.toBe("gilad");
  });

  it("thenReject() auto-rejects the next call", async () => {
    const { fake } = createProbePair<DemoService>();
    whenCalled(fake, "getName").thenReject(new Error("forbidden"));
    await expect(fake.getName(1)).rejects.toThrow("forbidden");
  });

  it("thenCall() delegates to function", async () => {
    const { fake } = createProbePair<DemoService>();
    whenCalled(fake, "getById").thenCall(async (id) => ({ id: id + 100 }));
    await expect(fake.getById(3)).resolves.toEqual({ id: 103 });
  });

  it("is consumed after one call — second call has no planned behavior", async () => {
    const { fake, probe } = createProbePair<DemoService>();
    whenCalled(fake, "getName").thenReturn("first");
    await expect(fake.getName(1)).resolves.toBe("first");

    void fake.getName(2);

    const autoSettledCall = await probe.expectNext();
    expect(autoSettledCall.method).toBe("getName");
    expect(autoSettledCall.args).toEqual([1]);
    expect(autoSettledCall.settled).toBe(true);

    const pendingCall = await probe.expectNext();
    expect(pendingCall.method).toBe("getName");
    expect(pendingCall.args).toEqual([2]);
    expect(pendingCall.settled).toBe(false);
  });
});

describe("alwaysReturn / alwaysReject / alwaysCall (permanent porcelain)", () => {
  it("alwaysReturn answers every call to that method", async () => {
    const { fake } = createProbePair<DemoService>();
    alwaysReturn(fake, "getName", "permanent");

    await expect(fake.getName(1)).resolves.toBe("permanent");
    await expect(fake.getName(2)).resolves.toBe("permanent");
    await expect(fake.getName(3)).resolves.toBe("permanent");
  });

  it("alwaysReject rejects every call to that method", async () => {
    const { fake } = createProbePair<DemoService>();
    alwaysReject(fake, "getName", new Error("always fails"));

    await expect(fake.getName(1)).rejects.toThrow("always fails");
    await expect(fake.getName(2)).rejects.toThrow("always fails");
  });

  it("alwaysCall delegates every call to that method", async () => {
    const { fake } = createProbePair<DemoService>();
    alwaysCall(fake, "getById", async (id) => ({ id: id * 10 }));

    await expect(fake.getById(1)).resolves.toEqual({ id: 10 });
    await expect(fake.getById(5)).resolves.toEqual({ id: 50 });
  });

  it("one-shot whenCalled takes priority over alwaysReturn", async () => {
    const { fake } = createProbePair<DemoService>();
    alwaysReturn(fake, "getName", "permanent");
    whenCalled(fake, "getName").thenReturn("override");

    await expect(fake.getName(1)).resolves.toBe("override");
    await expect(fake.getName(2)).resolves.toBe("permanent");
  });
});
