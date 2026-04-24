import { describe, expect, it } from "vitest";
import { Dedup } from "../../src/dedup.js";

describe("Dedup", () => {
  it("first sighting is fresh; exact replay is dropped", () => {
    let t = 1000;
    const d = new Dedup({ windowMs: 60_000, now: () => t });
    expect(d.isFresh("alice", "id1")).toBe(true);
    expect(d.isFresh("alice", "id1")).toBe(false);
  });

  it("same id from different senders does not collide", () => {
    let t = 1000;
    const d = new Dedup({ windowMs: 60_000, now: () => t });
    expect(d.isFresh("alice", "id1")).toBe(true);
    expect(d.isFresh("bob", "id1")).toBe(true);
    expect(d.isFresh("alice", "id1")).toBe(false);
  });

  it("entry expires after the window", () => {
    let t = 1000;
    const d = new Dedup({ windowMs: 1000, now: () => t });
    expect(d.isFresh("alice", "id1")).toBe(true);
    t = 1999;
    expect(d.isFresh("alice", "id1")).toBe(false);
    t = 2001;
    expect(d.isFresh("alice", "id1")).toBe(true);
  });

  it("size reflects active entries after eviction", () => {
    let t = 0;
    const d = new Dedup({ windowMs: 1000, now: () => t });
    d.isFresh("a", "1");
    t = 500;
    d.isFresh("a", "2");
    t = 1500;
    expect(d.size()).toBe(1);
    t = 2500;
    expect(d.size()).toBe(0);
  });
});
