import type { ContextItem, EpochOrdinalId, Message, RawSpan, SourceCharacter, SourceRole, SourceSnapshot, SpawnArrival } from "@spinejit/spine-sdk";
import { SPINE_SOURCE_SNAPSHOT_SCHEMA } from "@spinejit/spine-sdk";

import { OMP_ADAPTER_ID, type OmpSpineSourceEntry } from "./protocol.js";

const SOURCE_ROLES: Record<string, SourceRole> = {
  User: "user", ContextualUser: "contextual_user", Assistant: "assistant",
  Reply: "reply", Developer: "developer", System: "system",
};

interface SavedSource {
  character: SourceCharacter;
  nativeKey: string | null;
}

export class OmpSourceHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpSourceHistoryError";
  }
}

/** Decode untrusted custom-entry data without retaining unrelated native metadata. */
export function decodeOmpSourceEntry(raw: unknown, expectedThread?: string): OmpSpineSourceEntry {
  const value = raw as OmpSpineSourceEntry | null;
  if (
    value === null || typeof value !== "object" || Array.isArray(value) || value.schema !== OMP_ADAPTER_ID ||
    !isThread(value.thread) || !isOrdinal(value.epoch) ||
    !Array.isArray(value.characters) || value.characters.length === 0 ||
    !Array.isArray(value.nativeKeys) || value.nativeKeys.length !== value.characters.length
  ) {
    throw new OmpSourceHistoryError("OMP source checkpoint is malformed");
  }
  if (expectedThread !== undefined && value.thread !== expectedThread) {
    throw new OmpSourceHistoryError("OMP source checkpoint thread does not match the active history");
  }
  const characters: SourceCharacter[] = [];
  const nativeKeys: (string | null)[] = [];
  let previousBoundary = -1;
  for (let index = 0; index < value.characters.length; index += 1) {
    const character = decodeCharacter(value.characters[index]);
    const nativeKey = value.nativeKeys[index];
    requireNativeKey(character, nativeKey);
    nativeKeys.push(nativeKey);
    if (character.boundary <= previousBoundary) {
      throw new OmpSourceHistoryError("OMP source checkpoint boundaries are duplicate or out of order");
    }
    characters.push(character);
    previousBoundary = character.boundary;
  }
  return { schema: OMP_ADAPTER_ID, thread: value.thread, epoch: value.epoch, characters, nativeKeys };
}

/** Build this from checkpoints on the active native branch, never from archived prompts. */
export class OmpSourceHistory {
  readonly thread: string;
  readonly #epochs = new Map<number, Map<number, SavedSource>>();
  readonly #resolved = new Map<number, Set<number>>();
  readonly #nativeKeys = new Map<number, Map<string, number | number[]>>();

  constructor(thread: string) {
    if (!isThread(thread)) throw new OmpSourceHistoryError("OMP source history thread is malformed");
    this.thread = thread;
  }

  add(value: unknown): void {
    const entry = decodeOmpSourceEntry(value, this.thread);
    const existing = this.#epochs.get(entry.epoch);
    // Validate the entire delta before changing the state.
    for (let index = 0; index < entry.characters.length; index += 1) {
      const character = entry.characters[index]!;
      const previous = existing?.get(character.boundary);
      if (previous !== undefined && (
        !charactersEqual(previous.character, character) || previous.nativeKey !== entry.nativeKeys[index]
      )) {
        throw new OmpSourceHistoryError(`OMP source checkpoint conflict at ${entry.epoch}:${character.boundary}`);
      }
    }
    const characters = existing ?? new Map<number, SavedSource>();
    let keys = this.#nativeKeys.get(entry.epoch);
    for (let index = 0; index < entry.characters.length; index += 1) {
      const character = entry.characters[index]!;
      if (characters.has(character.boundary)) continue;
      const nativeKey = entry.nativeKeys[index]!;
      characters.set(character.boundary, { character, nativeKey });
      if (nativeKey === null) continue;
      if (keys === undefined) {
        keys = new Map();
        this.#nativeKeys.set(entry.epoch, keys);
      }
      const positions = keys.get(nativeKey);
      if (positions === undefined) keys.set(nativeKey, character.boundary);
      else if (typeof positions === "number") {
        keys.set(nativeKey, positions < character.boundary
          ? [positions, character.boundary] : [character.boundary, positions]);
      } else {
        const insertion = lowerBound(positions, character.boundary);
        positions.splice(insertion, 0, character.boundary);
      }
    }
    this.#epochs.set(entry.epoch, characters);
  }

  get(epoch: number, boundary: number): SourceCharacter | undefined {
    requirePosition(epoch, boundary);
    const character = this.#epochs.get(epoch)?.get(boundary)?.character;
    if (character === undefined) return undefined;
    return cloneCharacter(character);
  }

  nativeKey(epoch: number, boundary: number): string | null | undefined {
    requirePosition(epoch, boundary);
    return this.#epochs.get(epoch)?.get(boundary)?.nativeKey;
  }

  /** Native occurrences already assigned to an archive's canonical source prefix. */
  hasNativeKey(epoch: number, nativeKey: string, startBoundary: number, endBoundary: number): boolean {
    requirePosition(epoch, startBoundary);
    requirePosition(epoch, endBoundary);
    const positions = this.#nativeKeys.get(epoch)?.get(nativeKey);
    if (positions === undefined) return false;
    if (typeof positions === "number") return positions >= startBoundary && positions <= endBoundary;
    const candidate = positions[lowerBound(positions, startBoundary)];
    return candidate !== undefined && candidate <= endBoundary;
  }

  resolve(epoch: number, boundary: number, fallback: SourceCharacter, nativeKey: string | null): SourceCharacter;
  resolve(epoch: number, boundary: number): SourceCharacter | undefined;
  /** Call only after native source existence is established, including compact replacement cells. */
  resolve(epoch: number, boundary: number, fallback?: SourceCharacter, nativeKey?: string | null): SourceCharacter | undefined {
    requirePosition(epoch, boundary);
    const saved = this.#epochs.get(epoch)?.get(boundary);
    const character = saved?.character;
    if (fallback !== undefined) {
      const decoded = decodeCharacter(fallback);
      if (decoded.boundary !== boundary) {
        throw new OmpSourceHistoryError("OMP native source boundary does not match its checkpoint position");
      }
      if (character !== undefined && (
        decoded.type !== character.type ||
        (decoded.type === "message" && character.type === "message" && decoded.role !== character.role) ||
        ((decoded.type === "arrival" || decoded.type === "synthetic") && !charactersEqual(decoded, character))
      )) {
        throw new OmpSourceHistoryError("OMP native source type or role does not match its checkpoint");
      }
      requireNativeKey(decoded, nativeKey);
      if (saved !== undefined && saved.nativeKey !== nativeKey) {
        throw new OmpSourceHistoryError("OMP native source identity does not match its checkpoint");
      }
    }
    if (fallback === undefined && character !== undefined && character.type !== "synthetic") {
      throw new OmpSourceHistoryError("OMP checkpoint requires its native source identity or character");
    }
    if (character === undefined) return fallback;
    const resolved = this.#resolved.get(epoch) ?? new Set<number>();
    resolved.add(boundary);
    this.#resolved.set(epoch, resolved);
    return cloneCharacter(character);
  }

  /** Checkpoints cannot supply missing native messages, future epochs, or compact boundary gaps. */
  assertReplayComplete(): void {
    for (const [epoch, characters] of this.#epochs) {
      for (const boundary of characters.keys()) {
        if (!this.#resolved.get(epoch)?.has(boundary)) {
          throw new OmpSourceHistoryError(`OMP source checkpoint has no native source at ${epoch}:${boundary}`);
        }
      }
    }
  }

  /** Current-epoch saved cells must remain present; earlier compact epochs are intentionally absent. */
  assertSnapshotPositions(epoch: number, boundaries: ReadonlySet<number>): void {
    requirePosition(epoch, 0);
    for (const [savedEpoch, characters] of this.#epochs) {
      if (savedEpoch > epoch) {
        throw new OmpSourceHistoryError("OMP source checkpoint is in a future epoch");
      }
      if (savedEpoch === epoch) {
        for (const boundary of characters.keys()) {
          if (!boundaries.has(boundary)) {
            throw new OmpSourceHistoryError(`OMP source checkpoint is missing from the snapshot at ${epoch}:${boundary}`);
          }
        }
      }
    }
  }
}

/**
 * Pure delta stored in the replay lineage, not the explicitly supplied active snapshot namespace.
 * Inherited cells may retain their producer namespace. Append durably before adding the returned delta.
 */
export function buildOmpSourceCheckpoint(
  source: SourceSnapshot,
  history: OmpSourceHistory,
  getNativeKey: (sourceId: EpochOrdinalId) => string | null,
  expectedSnapshotThread: string = history.thread,
  getArrival: (sourceId: EpochOrdinalId) => SpawnArrival | undefined = () => undefined,
): OmpSpineSourceEntry | null {
  if (
    source === null || typeof source !== "object" ||
    source.schema !== SPINE_SOURCE_SNAPSHOT_SCHEMA || !isThread(source.thread) ||
    !isThread(expectedSnapshotThread) || source.thread !== expectedSnapshotThread ||
    !isOrdinal(source.epoch) || !Array.isArray(source.cells)
  ) {
    throw new OmpSourceHistoryError("OMP source snapshot identity does not match checkpoint history");
  }
  const characters: SourceCharacter[] = [];
  const nativeKeys: (string | null)[] = [];
  const boundaries = new Set<number>();
  const sourceIds = new Set<string>();
  let previousBoundary = -1;
  for (const cell of source.cells) {
    if (
      cell === null || typeof cell !== "object" || !isOrdinal(cell.boundary) || cell.boundary <= previousBoundary ||
      cell.source_id === null || typeof cell.source_id !== "object" || !isThread(cell.source_id.thread) ||
      cell.source_id.epoch !== source.epoch || !isOrdinal(cell.source_id.ordinal)
    ) {
      throw new OmpSourceHistoryError("OMP source snapshot cell identity or boundary is malformed");
    }
    const sourceId = JSON.stringify([cell.source_id.thread, cell.source_id.epoch, cell.source_id.ordinal]);
    if (sourceIds.has(sourceId)) {
      throw new OmpSourceHistoryError("OMP source snapshot has a duplicate source identity");
    }
    const arrival = getArrival(cell.source_id);
    const fromItem = characterFromItem(cell.boundary, cell.item);
    // DSH SpineChar::Arrival retains its payload separately from the Native.Rollout item.
    if (arrival !== undefined && fromItem.type !== "opaque") {
      throw new OmpSourceHistoryError("OMP arrival binding is not a native rollout cell");
    }
    const character = arrival === undefined ? fromItem : decodeCharacter({ type: "arrival", boundary: cell.boundary, arrival });
    const nativeKey = character.type === "message" || character.type === "arrival" ? getNativeKey(cell.source_id) : null;
    requireNativeKey(character, nativeKey);
    const saved = history.get(source.epoch, cell.boundary);
    if (saved !== undefined) {
      if (!charactersEqual(saved, character) || history.nativeKey(source.epoch, cell.boundary) !== nativeKey) {
        throw new OmpSourceHistoryError(`OMP source snapshot conflicts with checkpoint at ${source.epoch}:${cell.boundary}`);
      }
    } else {
      characters.push(character);
      nativeKeys.push(nativeKey);
    }
    boundaries.add(cell.boundary);
    sourceIds.add(sourceId);
    previousBoundary = cell.boundary;
  }
  history.assertSnapshotPositions(source.epoch, boundaries);
  return characters.length === 0 ? null : {
    schema: OMP_ADAPTER_ID,
    thread: history.thread,
    epoch: source.epoch,
    characters,
    nativeKeys,
  };
}

function requireNativeKey(character: SourceCharacter, value: unknown): asserts value is string | null {
  if (character.type === "message" || character.type === "arrival" ? typeof value !== "string" || value.length === 0 : value !== null) {
    throw new OmpSourceHistoryError("OMP source checkpoint native identity is malformed");
  }
}

function characterFromItem(boundary: number, value: unknown): SourceCharacter {
  const item = decodeContextItem(value);
  if ("Message" in item) {
    if (item.Message.message.boundary !== boundary) {
      throw new OmpSourceHistoryError("OMP source message boundary does not match its snapshot cell");
    }
    return { type: "message", boundary, role: SOURCE_ROLES[item.Message.message.role]!, content: item.Message.message.content };
  }
  if ("Native" in item && "Rollout" in item.Native.source) {
    if (item.Native.source.Rollout.ordinal !== boundary) {
      throw new OmpSourceHistoryError("OMP opaque source ordinal does not match its snapshot cell");
    }
    return { type: "opaque", boundary };
  }
  // CompactReplacement and other synthetic SDK cells keep their exact portable ContextItem.
  return { type: "synthetic", boundary, item: structuredClone(item) };
}

function decodeCharacter(raw: unknown): SourceCharacter {
  const value = raw as SourceCharacter | null;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !isOrdinal(value.boundary)) {
    throw new OmpSourceHistoryError("OMP source checkpoint character boundary is malformed");
  }
  if (value.type === "message" && typeof value.content === "string" && isSourceRole(value.role)) {
    requireKeys(value, ["type", "boundary", "role", "content"]);
    return { type: "message", boundary: value.boundary, role: value.role, content: value.content };
  }
  if (value.type === "opaque") {
    requireKeys(value, ["type", "boundary"]);
    return { type: "opaque", boundary: value.boundary };
  }
  if (value.type === "arrival") {
    requireKeys(value, ["type", "boundary", "arrival"]);
    return { type: "arrival", boundary: value.boundary, arrival: decodeArrival(value.arrival) };
  }
  if (value.type === "synthetic") {
    requireKeys(value, ["type", "boundary", "item"]);
    return { type: "synthetic", boundary: value.boundary, item: structuredClone(decodeContextItem(value.item)) };
  }
  throw new OmpSourceHistoryError("OMP source checkpoint character type, role, or content is malformed");
}

function decodeArrival(value: unknown): SpawnArrival {
  const arrival = value as SpawnArrival | null;
  if (arrival === null || typeof arrival !== "object" || Array.isArray(arrival) ||
    !Array.isArray(arrival.producer) || !arrival.producer.every(isOrdinal) ||
    !["completed", "errored", "aborted"].includes(arrival.outcome) ||
    ![arrival.memory, arrival.diagnostic, arrival.execution_ref].every((field) => field == null || typeof field === "string")) {
    throw new OmpSourceHistoryError("OMP source checkpoint arrival is malformed");
  }
  requireKeys(arrival, ["producer", "outcome", "memory", "diagnostic", "execution_ref"]);
  return { ...arrival, producer: [...arrival.producer] };
}

function decodeContextItem(value: unknown): ContextItem {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw new OmpSourceHistoryError("OMP source checkpoint context item is malformed");
  }
  const body: unknown = Object.values(value)[0];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OmpSourceHistoryError("OMP source checkpoint context item body is malformed");
  }
  const item = value as ContextItem;
  let valid = false;
  if ("Message" in item) {
    valid = isMessage(item.Message.message) && (item.Message.user_anchor === null || isOrdinal(item.Message.user_anchor));
    requireKeys(body, ["message", "user_anchor"]);
  } else if ("SourceSpan" in item) {
    valid = isSpan(item.SourceSpan.span) && (item.SourceSpan.without_reasoning === undefined ||
      typeof item.SourceSpan.without_reasoning === "boolean");
    requireKeys(body, ["span", "without_reasoning"]);
  } else if ("SyntheticNode" in item) {
    const node = item.SyntheticNode;
    valid = Array.isArray(node.node_id) && node.node_id.every(isOrdinal) && typeof node.summary === "string" &&
      ["Live", "Opened", "Closed", "Compacted"].includes(node.status);
    requireKeys(body, ["node_id", "summary", "status"]);
  } else if ("Native" in item) {
    const source = item.Native.source;
    requireKeys(body, ["source"]);
    if (source !== null && typeof source === "object" && !Array.isArray(source) && Object.keys(source).length === 1) {
      if ("Rollout" in source) {
        valid = source.Rollout !== null && typeof source.Rollout === "object" &&
          !Array.isArray(source.Rollout) && isOrdinal(source.Rollout.ordinal);
        if (valid) requireKeys(source.Rollout, ["ordinal"]);
      } else if ("CompactReplacement" in source) {
        const replacement = source.CompactReplacement;
        valid = replacement !== null && typeof replacement === "object" && !Array.isArray(replacement) &&
          isOrdinal(replacement.compact_boundary) && isOrdinal(replacement.index);
        if (valid) requireKeys(replacement, ["compact_boundary", "index"]);
      }
    }
  } else if ("MemorySlot" in item && item.MemorySlot !== null && typeof item.MemorySlot === "object" &&
    !Array.isArray(item.MemorySlot) && Object.keys(item.MemorySlot).length === 1) {
    const slot = item.MemorySlot;
    const payload: unknown = Object.values(slot)[0];
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      if ("User" in slot) {
        const user = slot.User;
        valid = Array.isArray(user.owner_node) && user.owner_node.every(isOrdinal) &&
          isMessage(user.message) && isOrdinal(user.anchor);
        requireKeys(payload, ["owner_node", "message", "anchor"]);
      } else if ("Summary" in slot) {
        const summary = slot.Summary;
        valid = Array.isArray(summary.owner_node) && summary.owner_node.every(isOrdinal) &&
          isSpan(summary.source) && typeof summary.body === "string";
        requireKeys(payload, ["owner_node", "source", "body"]);
      } else if ("Birth" in slot) {
        const birth = slot.Birth;
        valid = Array.isArray(birth.owner_node) && birth.owner_node.every(isOrdinal) &&
          isSpan(birth.source) && birth.task !== null && typeof birth.task === "object" &&
          !Array.isArray(birth.task) && typeof birth.task.summary === "string" && typeof birth.task.prompt === "string";
        requireKeys(payload, ["owner_node", "source", "task"]);
        if (valid) requireKeys(birth.task, ["summary", "prompt"]);
      } else if ("Arrival" in slot) {
        valid = Array.isArray(slot.Arrival.owner_node) && slot.Arrival.owner_node.every(isOrdinal) &&
          isOrdinal(slot.Arrival.boundary) && !!decodeArrival(slot.Arrival.arrival);
        requireKeys(payload, ["owner_node", "boundary", "arrival"]);
      } else if ("Reply" in slot) {
        valid = Array.isArray(slot.Reply.owner_node) && slot.Reply.owner_node.every(isOrdinal) && isMessage(slot.Reply.message);
        requireKeys(payload, ["owner_node", "message"]);
      }
    }
  }
  if (!valid) throw new OmpSourceHistoryError("OMP source checkpoint context item type or fields are malformed");
  return item;
}

function isMessage(raw: unknown): boolean {
  const value = raw as Message | null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  requireKeys(value, ["boundary", "role", "content"]);
  return isOrdinal(value.boundary) && typeof value.content === "string" &&
    ["User", "ContextualUser", "Assistant", "Reply", "Developer", "System"].includes(value.role);
}

function isSpan(raw: unknown): boolean {
  const value = raw as RawSpan | null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  requireKeys(value, ["start", "end"]);
  return isOrdinal(value.start) && isOrdinal(value.end) && value.end >= value.start;
}

function isSourceRole(value: unknown): value is SourceRole {
  return typeof value === "string" && ["user", "contextual_user", "assistant", "reply", "developer", "system"].includes(value);
}

function requireKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new OmpSourceHistoryError("OMP source checkpoint character has unknown fields");
  }
}

function charactersEqual(left: SourceCharacter, right: SourceCharacter): boolean {
  if (left.type !== right.type || left.boundary !== right.boundary) return false;
  if (left.type === "message" && right.type === "message") return left.role === right.role && left.content === right.content;
  if (left.type === "synthetic" && right.type === "synthetic") return jsonEqual(left.item, right.item);
  if (left.type === "arrival" && right.type === "arrival") return jsonEqual(left.arrival, right.arrival);
  return left.type === "opaque";
}

function cloneCharacter(character: SourceCharacter): SourceCharacter {
  return character.type === "synthetic" || character.type === "arrival" ? structuredClone(character) : { ...character };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (
    left === null || right === null || typeof left !== "object" || typeof right !== "object" ||
    Array.isArray(left) || Array.isArray(right)
  ) return false;
  const leftFields = left as Record<string, unknown>;
  const rightFields = right as Record<string, unknown>;
  const keys = Object.keys(leftFields);
  return keys.length === Object.keys(rightFields).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightFields, key) && jsonEqual(leftFields[key], rightFields[key]));
}


function requirePosition(epoch: number, boundary: number): void {
  if (!isOrdinal(epoch) || !isOrdinal(boundary)) {
    throw new OmpSourceHistoryError("OMP source checkpoint lookup position is malformed");
  }
}

function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isThread(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}


function lowerBound(boundaries: readonly number[], target: number): number {
  let left = 0;
  let right = boundaries.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (boundaries[middle]! < target) left = middle + 1;
    else right = middle;
  }
  return left;
}
