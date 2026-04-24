const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isValidConcreteTopic(topic: string): boolean {
  if (!topic) return false;
  return topic.split(".").every((s) => SEGMENT.test(s));
}

export function isValidPattern(pattern: string): boolean {
  if (!pattern) return false;
  return pattern.split(".").every((s) => s === "*" || SEGMENT.test(s));
}

export function matches(pattern: string, topic: string): boolean {
  if (!isValidPattern(pattern) || !isValidConcreteTopic(topic)) return false;
  const ps = pattern.split(".");
  const ts = topic.split(".");
  if (ps.length !== ts.length) return false;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] !== "*" && ps[i] !== ts[i]) return false;
  }
  return true;
}
