/* One cancellable request at a time: begin() replaces the controller, abort() cancels it, release() forgets it. */
import { useState } from "react";

export type AbortSlot = {
  begin: () => AbortController;
  abort: () => void;
  release: (controller: AbortController) => void;
};

function createAbortSlot(): AbortSlot {
  let current: AbortController | null = null;
  return {
    begin() {
      current = new AbortController();
      return current;
    },
    abort() {
      current?.abort();
    },
    release(controller) {
      if (current === controller) current = null;
    },
  };
}

/** A stable abort slot for the lifetime of the component. */
export function useAbortSlot() {
  const [slot] = useState(createAbortSlot);
  return slot;
}
