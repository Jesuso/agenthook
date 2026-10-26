import { useSyncExternalStore } from "react";
import { getReading, subscribeReading } from "./reading";
import type { ReadingValues } from "./reading";

/** The reading settings, re-rendering on every `setReading` (the panel's change and Reset). */
export const useReading = (): ReadingValues => useSyncExternalStore(subscribeReading, getReading, getReading);
