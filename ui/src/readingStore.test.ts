// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { getReading, setReading, subscribeReading } from "./reading";

const DEFAULTS = { text: "0", spacing: "off", measure: "default", bg: "default", readaloud: "off", rate: "1", autoread: "off" };

describe("reading store", () => {
  it("setReading persists, applies and notifies every subscriber; the last unsubscribe drops the copy", () => {
    localStorage.removeItem("ah-reading");
    const seen: string[] = [];
    const off1 = subscribeReading(() => seen.push("a"));
    const off2 = subscribeReading(() => seen.push("b"));
    expect(getReading()).toEqual(DEFAULTS);
    setReading({ ...DEFAULTS, readaloud: "on" });
    expect(seen).toEqual(["a", "b"]);
    expect(getReading().readaloud).toBe("on");
    expect(JSON.parse(localStorage.getItem("ah-reading")!)).toEqual({ readaloud: "on" });
    expect(document.documentElement.getAttribute("data-ah-readaloud")).toBe("on");
    off1();
    off2();
    localStorage.setItem("ah-reading", JSON.stringify({ rate: "1.5" }));
    expect(getReading()).toEqual({ ...DEFAULTS, rate: "1.5" });
    setReading(DEFAULTS);
    expect(localStorage.getItem("ah-reading")).toBeNull();
    expect(document.documentElement.hasAttribute("data-ah-readaloud")).toBe(false);
  });
});
