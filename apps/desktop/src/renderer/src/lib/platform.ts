import { useEffect, useState } from "react";
import type { PlatformInfo } from "@vunemi/platform";

/**
 * Which system Vunemi runs on and what it offers there, asked of main once.
 * Until the answer arrives nothing is hidden: macOS behaves as it always has.
 */
let known: PlatformInfo | null = null;
let asking: Promise<PlatformInfo> | null = null;

/** Asks main, once; later calls share the answer. */
export function ask(): Promise<PlatformInfo> {
  // A window without the bridge (a test, a preview) is treated as macOS was: nothing hidden.
  asking ??= typeof window.vunemi?.platformInfo === "function"
    ? window.vunemi.platformInfo().then((info) => (known = info))
    : Promise.reject(new Error("no platform bridge"));
  return asking;
}

/** The answer, if it has arrived: for code outside React. */
export function platformNow(): PlatformInfo | null {
  return known;
}

export function usePlatform(): PlatformInfo | null {
  const [info, setInfo] = useState<PlatformInfo | null>(known);
  useEffect(() => {
    if (known) return;
    let live = true;
    void ask().then((answer) => live && setInfo(answer), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** Whether a feature is offered here. Unknown yet counts as offered. */
export function useFeature(feature: keyof PlatformInfo["features"]): boolean {
  return usePlatform()?.features[feature] ?? true;
}
