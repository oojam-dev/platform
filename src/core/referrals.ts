/**
 * Sharing and referrals: the viral loop. Shared links carry ?ref=<github login>. We count share
 * clicks, visits that arrive through a link, sign-ups and votes it brings, and from those the
 * viral coefficient (how many new voters each voter brings in).
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { refVisits, shares, users, votes } from "../db/schema.js";

export const SHARE_CHANNELS = ["native", "copy", "x", "bluesky", "linkedin", "reddit", "hackernews", "email", "embed"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export async function userIdByLogin(db: DbOrTx, login: string | null | undefined): Promise<number | null> {
  if (!login || !LOGIN.test(login)) return null;
  const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.githubLogin}) = lower(${login})`);
  return u?.id ?? null;
}

export async function recordShare(db: DbOrTx, args: { ideaId: number; userId: number | null; channel: string }): Promise<void> {
  const channel = (SHARE_CHANNELS as readonly string[]).includes(args.channel) ? args.channel : "other";
  await db.insert(shares).values({ ideaId: args.ideaId, userId: args.userId, channel });
}

/** A visit through someone's link. Unknown logins are ignored. */
export async function recordRefVisit(db: DbOrTx, args: { ideaId: number | null; referrerLogin: string }): Promise<number | null> {
  const referrerId = await userIdByLogin(db, args.referrerLogin);
  if (referrerId) await db.insert(refVisits).values({ ideaId: args.ideaId, referrerId });
  return referrerId;
}

/** On sign-up only: who brought this account here. Never overwritten, never self. */
export async function setReferrer(db: DbOrTx, userId: number, referrerLogin: string | null | undefined): Promise<void> {
  const referrerId = await userIdByLogin(db, referrerLogin);
  if (!referrerId || referrerId === userId) return;
  await db
    .update(users)
    .set({ referredBy: referrerId })
    .where(and(eq(users.id, userId), sql`${users.referredBy} is null`));
}

/** Per idea: how many voters came through shares, and who brought them. */
export async function referralSummary(db: DbOrTx, ideaId: number) {
  const top = await db
    .select({ login: users.githubLogin, avatarUrl: users.avatarUrl, voters: sql<number>`count(*)::int` })
    .from(votes)
    .innerJoin(users, eq(users.id, votes.referrerId))
    .where(and(eq(votes.ideaId, ideaId), isNotNull(votes.referrerId)))
    .groupBy(users.id)
    .orderBy(desc(sql`count(*)`))
    .limit(5);
  return { refVoters: top.reduce((n, r) => n + r.voters, 0), topSharers: top };
}

/** Everyone, over a window: who brought the most voters in. Public social proof. */
export async function topSharers(db: DbOrTx, limit = 10, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  return db
    .select({ login: users.githubLogin, avatarUrl: users.avatarUrl, voters: sql<number>`count(*)::int` })
    .from(votes)
    .innerJoin(users, eq(users.id, votes.referrerId))
    .where(and(isNotNull(votes.referrerId), gte(votes.createdAt, since)))
    .groupBy(users.id)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export interface ViralStats {
  days: number;
  shares: Record<string, number>;
  refVisits: number;
  newUsers: number;
  refSignups: number;
  voters: number;
  refVotes: number;
  /** New accounts that arrived through a share, per account active in the window. */
  kFactor: number;
}

export async function viralStats(db: DbOrTx, days = 7): Promise<ViralStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const shareRows = await db
    .select({ channel: shares.channel, n: sql<number>`count(*)::int` })
    .from(shares)
    .where(gte(shares.createdAt, since))
    .groupBy(shares.channel);
  const [visits] = await db.select({ n: sql<number>`count(*)::int` }).from(refVisits).where(gte(refVisits.createdAt, since));
  const [signups] = await db
    .select({ all: sql<number>`count(*)::int`, referred: sql<number>`(count(*) filter (where ${users.referredBy} is not null))::int` })
    .from(users)
    .where(gte(users.createdAt, since));
  const [v] = await db
    .select({ voters: sql<number>`count(distinct ${votes.userId})::int`, referred: sql<number>`(count(*) filter (where ${votes.referrerId} is not null))::int` })
    .from(votes)
    .where(gte(votes.createdAt, since));
  const voters = v?.voters ?? 0;
  const refSignups = signups?.referred ?? 0;
  return {
    days,
    shares: Object.fromEntries(shareRows.map((r) => [r.channel, r.n])),
    refVisits: visits?.n ?? 0,
    newUsers: signups?.all ?? 0,
    refSignups,
    voters,
    refVotes: v?.referred ?? 0,
    kFactor: voters ? Math.round((refSignups / voters) * 100) / 100 : 0,
  };
}
