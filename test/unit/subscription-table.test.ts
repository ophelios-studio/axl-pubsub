import { describe, expect, it } from "vitest";
import { SubscriptionTable } from "../../src/subscription-table.js";

describe("SubscriptionTable", () => {
  it("upsert of a new peer returns 'new' and records topics", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    const r = tbl.upsert({ from: "alice", topics: ["news.*"], seq: 1, ttlMs: 1000 });
    expect(r.kind).toBe("new");
    expect(tbl.size()).toBe(1);
    expect(tbl.has("alice")).toBe(true);
  });

  it("same topics at higher seq returns 'refreshed' and extends expiry", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["news.*"], seq: 1, ttlMs: 1000 });
    t = 500;
    const r = tbl.upsert({ from: "alice", topics: ["news.*"], seq: 2, ttlMs: 1000 });
    expect(r.kind).toBe("refreshed");
    t = 1200;
    expect(tbl.has("alice")).toBe(true);
  });

  it("different topics at higher seq returns 'changed' with prev list", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["news.*"], seq: 1, ttlMs: 1000 });
    const r = tbl.upsert({ from: "alice", topics: ["news.*", "other.*"], seq: 2, ttlMs: 1000 });
    expect(r.kind).toBe("changed");
    if (r.kind !== "changed") return;
    expect(r.prevTopics).toEqual(["news.*"]);
    expect(r.topics).toEqual(["news.*", "other.*"]);
  });

  it("rejects non-monotonic seq as 'stale'", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["a"], seq: 5, ttlMs: 1000 });
    const r = tbl.upsert({ from: "alice", topics: ["b"], seq: 5, ttlMs: 1000 });
    expect(r.kind).toBe("stale");
    expect(tbl.peers()[0]?.topics).toEqual(["a"]);
  });

  it("sweepExpired returns removed pubkeys and drops them from the table", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["a"], seq: 1, ttlMs: 1000 });
    tbl.upsert({ from: "bob", topics: ["b"], seq: 1, ttlMs: 5000 });
    t = 2000;
    expect(tbl.sweepExpired()).toEqual(["alice"]);
    expect(tbl.size()).toBe(1);
    expect(tbl.has("bob")).toBe(true);
  });

  it("subscribersFor matches patterns against the given concrete topic", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["news.*"], seq: 1, ttlMs: 10_000 });
    tbl.upsert({
      from: "bob",
      topics: ["immunity.antibody.*"],
      seq: 1,
      ttlMs: 10_000,
    });
    tbl.upsert({ from: "charlie", topics: ["other.*"], seq: 1, ttlMs: 10_000 });
    const subs = tbl.subscribersFor("immunity.antibody.address").sort();
    expect(subs).toEqual(["bob"]);
  });

  it("expired peer re-entering with fresh ad is treated as 'new'", () => {
    let t = 0;
    const tbl = new SubscriptionTable({ now: () => t });
    tbl.upsert({ from: "alice", topics: ["a"], seq: 1, ttlMs: 1000 });
    t = 2000;
    const r = tbl.upsert({ from: "alice", topics: ["a"], seq: 2, ttlMs: 1000 });
    expect(r.kind).toBe("new");
  });
});
