// Conversation state lives in code (rule 3): one JSON object per session, created and updated only by
// the server. The app has no database, so the server hands the state back as an HMAC-signed token that
// the browser stores and returns unchanged; a token that was altered or signed with another key is rejected.
import { CONFIG } from "../config";
import type { ModuleResult } from "./schemas";

export interface Topic {
  id: string;
  module: string;
  status: "active" | "parked";
  slots: Record<string, string>;
  summary: string;
  last_result_ref: string | null;
  /** Slots this topic has already asked about (so the same thing is never asked twice). */
  asked?: string[];
  /** Slots filled by a registry fallback instead of the user (results first, then one follow-up question). */
  assumed?: Record<string, string>;
}
export interface Session {
  session_id: string;
  user: {
    language: string;
    citizenship: string;
    home_city: string;
    /** Country of home_city. When the user's citizenship differs, home_city is not assumed as the origin. */
    home_country: string;
    /** false once the user says something that makes the profile home city doubtful (e.g. a foreign passport). */
    home_city_confirmed: boolean;
  };
  active_topic_id: string | null;
  topics: Topic[];
  recent_turns: { role: "user" | "assistant"; text: string }[];
  pending_intents: string[];
  next_topic_num: number;
  /** Tool results stored by code under last_result_ref. Never pasted into prompts wholesale. */
  results: Record<string, ModuleResult>;
}

export function newSession(
  user?: {
    language?: string | undefined;
    citizenship?: string | undefined;
    home_city?: string | undefined;
  } | null,
): Session {
  return {
    session_id: "s_" + crypto.randomUUID(),
    user: {
      language: user?.language || "az",
      citizenship: user?.citizenship || "AZ",
      home_city: user?.home_city || "Baku",
      home_country: "AZ",
      home_city_confirmed: true,
    },
    active_topic_id: null,
    topics: [],
    recent_turns: [],
    pending_intents: [],
    next_topic_num: 1,
    results: {},
  };
}
export const activeTopic = (s: Session) => s.topics.find((t) => t.id === s.active_topic_id) ?? null;

export function saveResult(s: Session, r: ModuleResult): string {
  const ref = "r_" + crypto.randomUUID().slice(0, 12);
  s.results[ref] = r;
  // Keep only results that a topic still points to (one per topic).
  const live = new Set(s.topics.map((t) => t.last_result_ref).filter(Boolean));
  live.add(ref);
  for (const k of Object.keys(s.results)) if (!live.has(k)) delete s.results[k];
  return ref;
}
export const getResult = (s: Session, ref: string | null) =>
  ref ? (s.results[ref] ?? null) : null;

// ---------- signed token ----------
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(data: string): Promise<string> {
  const secret = CONFIG.stateSecret() || "dev-only-secret";
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("bir-chat-state:" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function encodeState(s: Session): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(s)));
  return `${payload}.${await hmac(payload)}`;
}

/** Returns the session, or null when the token is missing, altered or unreadable (then a new session starts). */
export async function decodeState(token: string | null | undefined): Promise<Session | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(payload);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    s.user.home_country ??= "AZ";
    s.user.home_city_confirmed ??= true;
    return s;
  } catch {
    return null;
  }
}
