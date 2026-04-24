import { describe, expect, it } from "vitest";
import { isValidConcreteTopic, isValidPattern, matches } from "../../src/topic-matcher.js";

describe("isValidConcreteTopic", () => {
  it.each(["immunity.antibody.address", "a", "a.b.c", "news-feed.v1", "a_b.c_d"])(
    "accepts %s",
    (t) => {
      expect(isValidConcreteTopic(t)).toBe(true);
    },
  );
  it.each(["", ".", "a.", ".a", "a..b", "a.*", "a b.c", "a.#", "a.b/c"])("rejects %j", (t) => {
    expect(isValidConcreteTopic(t)).toBe(false);
  });
});

describe("isValidPattern", () => {
  it.each(["a.*", "*", "immunity.antibody.*", "a.b.c", "*.*.*"])("accepts %s", (p) => {
    expect(isValidPattern(p)).toBe(true);
  });
  it.each(["", "a.#", "a.**", "a..*", "a.*b"])("rejects %j", (p) => {
    expect(isValidPattern(p)).toBe(false);
  });
});

describe("matches", () => {
  it("exact match", () => {
    expect(matches("immunity.antibody.address", "immunity.antibody.address")).toBe(true);
  });
  it("single-segment wildcard", () => {
    expect(matches("immunity.antibody.*", "immunity.antibody.address")).toBe(true);
    expect(matches("immunity.antibody.*", "immunity.antibody.call_pattern")).toBe(true);
  });
  it("wildcard does NOT cross segment boundaries", () => {
    expect(matches("immunity.antibody.*", "immunity.antibody.a.b")).toBe(false);
    expect(matches("immunity.*", "immunity.antibody.address")).toBe(false);
  });
  it("different segment counts do not match", () => {
    expect(matches("a.b", "a.b.c")).toBe(false);
    expect(matches("a.b.c", "a.b")).toBe(false);
  });
  it("case-sensitive", () => {
    expect(matches("News.test", "news.test")).toBe(false);
  });
  it("pattern or topic invalidity returns false", () => {
    expect(matches("a.#", "a.b")).toBe(false);
    expect(matches("a.*", "a.*")).toBe(false);
  });
  it("root wildcard matches exactly one segment", () => {
    expect(matches("*", "a")).toBe(true);
    expect(matches("*", "a.b")).toBe(false);
  });
});
