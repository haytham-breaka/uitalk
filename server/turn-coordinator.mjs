// The approval/undo lifecycle as one explicit model, so its invariants live in a
// single place and are enforced by state transitions rather than by guards scattered
// across the bridge.
//
// It owns two things:
//
//   1. A phase machine for the LOCAL turn (builtin/adapter/opencode), which serializes
//      one snapshot -> edit -> settle (or a revert) at a time. This is about whether
//      the bridge itself is mid-operation; it does not, by itself, model the changes.
//
//        idle --approve--> snapshotting --taken--> editing --turn end--> idle
//        snapshotting --failed--> idle
//        idle --undo--> reverting --done--> idle
//
//   2. A set of Change objects — the first-class approvals. Each has a stable id, an
//      owner (the external agent it was assigned to, if any), its pre-edit snapshot,
//      the files finally attributed to it, and an explicit state:
//
//        editing   — approved and handed to its owner; the edit is in progress
//        recorded  — the post-edit state is frozen; this is the undo point
//        reverted  — undone
//        (a change dropped from the set — superseded by a New Session — simply leaves)
//
// Why a set and not one slot: in agent:off mode several approvals can be in flight at
// once (each edited by an MCP client and reported later), so a single "last change"
// could not tell them apart — the source of a whole class of misattribution bugs.
// builtin/adapter/opencode serialize (the phase machine allows one at a time), so they
// only ever have one editing change; the same model covers both.
//
// The invariants this enforces:
//   - identity: every change has a unique, stable id.
//   - correlation: resolve() maps a completion to exactly one change or fails. An
//     explicit id resolves to that change or is refused unknown — it never lands on a
//     different one. Without an id it resolves only when unambiguous (<=1 outstanding).
//   - one undo point: `current` is the most recently recorded change; revert targets it.
//   - ownership is carried on the change (ownerAgentId); routing/acceptance is the
//     bridge's job, but the identity lives here.

const LEGAL_FROM = {
  snapshotting: new Set(["idle"]),
  editing: new Set(["snapshotting"]),
  reverting: new Set(["idle"]),
};

// How many changes to keep. Only "editing" ones can pile up (a client that never
// reports completion); recorded/reverted are pruned as new ones arrive past the cap.
const CHANGE_CAP = 64;

export class TurnCoordinator {
  #phase = "idle";
  #changes = new Map(); // id -> Change
  #seq = 0;
  #currentId = null; // the recorded change revert targets
  pendingApprovals = [];
  #writes = { paths: new Set(), complete: true };

  get phase() {
    return this.#phase;
  }
  get isIdle() {
    return this.#phase === "idle";
  }

  #transition(next) {
    const allowed = LEGAL_FROM[next];
    if (allowed && !allowed.has(this.#phase)) {
      throw new Error(`illegal turn transition: ${this.#phase} -> ${next}`);
    }
    this.#phase = next;
  }

  /** Begin an approval: take the pre-edit snapshot. Also resets write attribution,
   * scoping this approval's undo to what the agent writes from here. */
  snapshotting() {
    this.#transition("snapshotting");
    this.resetWrites();
  }
  /** The snapshot exists; the agent may now edit. */
  editing() {
    this.#transition("editing");
  }
  /** Begin undoing the current recorded change. */
  reverting() {
    this.#transition("reverting");
  }
  /** Return to rest after a turn/revert completes — or after a failure. Always legal. */
  settle() {
    this.#phase = "idle";
  }
  /** A new session abandons whatever was in flight: reset the whole lifecycle. */
  clear() {
    this.#phase = "idle";
    this.#changes.clear();
    this.#currentId = null;
    this.pendingApprovals.length = 0;
    this.resetWrites();
  }

  // --- changes ---------------------------------------------------------------

  /** Open a new change in the "editing" state and return it. `snap` is its pre-edit
   * snapshot (may be null when the project is not a git repo); `ownerAgentId` is the
   * external agent it is assigned to (null for builtin/adapter/opencode). */
  openChange({ label, snap, ownerAgentId = null }) {
    const change = { id: ++this.#seq, label, snap, ownerAgentId, files: null, state: "editing" };
    this.#changes.set(change.id, change);
    this.#evict();
    return change;
  }

  /** Freeze a change as the undo point: its post-edit snapshot is captured, the files
   * attributed to it are recorded, and it becomes `current`. */
  recordChange(change, files = null) {
    change.state = "recorded";
    change.files = files;
    this.#currentId = change.id;
  }

  /** The change a revert would undo: the most recently recorded one, or null. */
  get current() {
    const c = this.#changes.get(this.#currentId);
    return c && c.state === "recorded" ? c : null;
  }

  /** Mark the current change undone; there is then nothing to revert. */
  markReverted() {
    const c = this.current;
    if (c) c.state = "reverted";
    this.#currentId = null;
  }

  changeById(id) {
    return this.#changes.get(id) ?? null;
  }

  /** Changes still being edited (approved, not yet recorded). */
  outstanding() {
    return [...this.#changes.values()].filter((c) => c.state === "editing");
  }

  /**
   * Resolve which change a completion (note_edit / turn end) finishes:
   *   - an explicit id of an editing change     -> that change
   *   - an explicit id that is already the recorded undo point -> that change (a
   *     duplicate completion is then a harmless no-op)
   *   - an explicit id we don't recognize        -> { error: "unknown-change" }
   *   - no id, exactly one change editing         -> that one
   *   - no id, none editing                       -> the current recorded change (a
   *     builtin/adapter turn end, or a legacy single-change client), or null
   *   - no id, several editing                    -> { error: "ambiguous-change" }
   * It never falls through an explicit id onto a different change.
   */
  resolve(id) {
    if (id != null) {
      const editing = this.#changes.get(id);
      if (editing && editing.state === "editing") return { change: editing };
      if (this.current?.id === id) return { change: this.current };
      return { error: "unknown-change" };
    }
    const editing = this.outstanding();
    if (editing.length > 1) return { error: "ambiguous-change" };
    if (editing.length === 1) return { change: editing[0] };
    return { change: this.current };
  }

  #evict() {
    while (this.#changes.size > CHANGE_CAP) {
      // Drop the oldest change that is NOT the current undo point; prefer already
      // finished (recorded/reverted) ones, but an over-cap backlog of never-completed
      // editing changes may be dropped too (its client went away).
      const victim =
        [...this.#changes.values()].find((c) => c.id !== this.#currentId && c.state !== "editing") ??
        [...this.#changes.values()].find((c) => c.id !== this.#currentId);
      if (!victim) break;
      this.#changes.delete(victim.id);
    }
  }

  // --- write attribution (see index.mjs's noteAgentWrite / markOpaqueTool) ---

  resetWrites() {
    this.#writes = { paths: new Set(), complete: true };
  }
  /** Record a project-relative path the agent wrote. */
  noteWrite(rel) {
    this.#writes.paths.add(rel);
  }
  /** A tool ran whose file effects can't be attributed (a shell tool); the write set
   * is no longer the whole story, so undo must fall back to the full diff. */
  markWritesIncomplete() {
    this.#writes.complete = false;
  }
  get writes() {
    return this.#writes;
  }
  /** The paths to scope undo to, or null to fall back to the full diff — used only
   * when the write set is complete AND non-empty. */
  writeScope() {
    return this.#writes.complete && this.#writes.paths.size ? [...this.#writes.paths] : null;
  }
}
