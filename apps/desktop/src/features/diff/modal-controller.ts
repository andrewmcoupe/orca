/**
 * Tiny pub/sub for "open the diff modal at concern N for task T". Lets the
 * verdict-card concern rows on the task detail page open the modal that lives
 * inside the same task detail tree, without threading callbacks through the
 * intervening components.
 *
 * Multiple subscribers are allowed (in practice one — the modal mount), and the
 * latest open() call always wins.
 */

export type DiffModalRequest = {
  taskId: string;
  /** Optional zero-based concern index in the task's mapped_concerns list. */
  concernIndex?: number;
};

type Listener = (req: DiffModalRequest) => void;

const listeners = new Set<Listener>();

export const diffModalController = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  open(req: DiffModalRequest): void {
    for (const l of listeners) l(req);
  },
};
