// The turn/approval lifecycle as one explicit state machine, so its legal moves are
// declared in a single place and are testable — instead of bare `approvalPhase = …`
// assignments scattered across the bridge. It owns the phase and the state that
// phase gates: the last committed change (what undo restores), approvals held while
// a turn is still running, and the write attribution for the edit in flight.
//
// It does NOT own the builtin inbox (backlog / wake / internal / builtinTurnOpen):
// that is transport — a prompt queue feeding the SDK — which exists independently of
// any approval, so it stays in index.mjs. `agentBusy()` there still decides when a
// racing approval must wait.
//
// Phases and the ONLY legal moves between them (clear() forces idle from anywhere —
// a new session abandons whatever was in flight):
//
//     idle         --approve-->  snapshotting        beginApproval() starts
//     snapshotting --taken----->  editing            the pre-edit snapshot exists
//     snapshotting --failed---->  idle               the snapshot rejected
//     editing      --turn end-->  idle               the agent's edit turn finished
//     idle         --undo------>  reverting          a revert starts
//     reverting    --done------>  idle               the revert finished
//
// The forward moves (snapshotting/editing/reverting) assert their source phase, so
// an illegal transition (idle -> editing without a snapshot, revert while editing,
// two approvals at once) throws rather than silently corrupting state. Returning to
// idle — settle() on completion or failure, clear() on a new session — is always
// allowed. Production never triggers an illegal move (the frame handlers guard on
// phase first); the assertions exist to catch a future wiring mistake and to test.

const LEGAL_FROM = {
  snapshotting: new Set(["idle"]),
  editing: new Set(["snapshotting"]),
  reverting: new Set(["idle"]),
};

export class TurnCoordinator {
  #phase = "idle";
  lastChange = null;
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
  /** Begin undoing the last committed change. */
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
    this.lastChange = null;
    this.pendingApprovals.length = 0;
    this.resetWrites();
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
