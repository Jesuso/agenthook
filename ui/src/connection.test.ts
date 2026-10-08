import { describe, it, expect } from "vitest";
import { connectionState, CONNECTION_LABEL } from "./connection";

describe("connectionState", () => {
  it("open stream → connected", () => expect(connectionState(true, false)).toBe("connected"));
  it("not open yet / retrying → reconnecting", () => expect(connectionState(false, false)).toBe("reconnecting"));
  it("closed wins either way", () => {
    expect(connectionState(false, true)).toBe("closed");
    expect(connectionState(true, true)).toBe("closed");
  });
  it("labels every state", () => {
    expect(CONNECTION_LABEL).toEqual({ connected: "Live", reconnecting: "Reconnecting…", closed: "Disconnected — reload" });
  });
});
