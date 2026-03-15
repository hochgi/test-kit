import { createInMemoryCache } from "../src";

describe("createInMemoryCache", () => {
  it("set/get/del works", async () => {
    const cache = createInMemoryCache();

    const setResult = await cache.set({ key: "user:1", val: { id: 1, name: "neo" } });
    expect(setResult).toBe(true);

    const val = await cache.get<{ id: number; name: string }>("user:1");
    expect(val).toEqual({ id: 1, name: "neo" });

    await cache.del("user:1");
    const deleted = await cache.get("user:1");
    expect(deleted).toBeNull();
  });

  it("supports formatted keys", async () => {
    const cache = createInMemoryCache();

    await cache.set({ key: { format: "site:%s:user:%s", args: ["123", "7"] }, val: "ok" });
    await expect(cache.get<string>("site:123:user:7")).resolves.toBe("ok");
  });

  it("setnx stores only when missing", async () => {
    const cache = createInMemoryCache();
    await cache.set({ key: "feature", val: "A" });
    const result = await cache.setnx({ key: "feature", val: "B" });
    expect(result).toBe("A");
    await expect(cache.get<string>("feature")).resolves.toBe("A");
  });

  it("getSet caches result and reuses it", async () => {
    const cache = createInMemoryCache();
    const apiCall = jest.fn(async () => ({ ok: true }));

    const first = await cache.getSet("k1", apiCall);
    const second = await cache.getSet("k1", apiCall);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(apiCall).toHaveBeenCalledTimes(1);
  });
});
