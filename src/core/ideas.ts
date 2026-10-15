/** Ideas: screening, the board, detail pages and comments (SPEC §2.2). */
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";

import type { Database, DbOrTx } from "../db/client.js";
import { builds, comments, ideas, users, votes, type IdeaStatus } from "../db/schema.js";
import { audit } from "./controls.js";
import { RuleError } from "./errors.js";
import { budgetLeftTodayCents, chargeScreening } from "./spend.js";
import { rejectAtScreening } from "./votes.js";
import { usdToCents } from "./pricing.js";
import { screenIdea } from "./screen.js";

export type BoardSort = "top" | "new" | "built";

export interface BoardItem {
  id: number;
  title: string;
  status: IdeaStatus;
  voteCount: number;
  createdAt: Date;
  author: string;
  authorAvatar: string | null;
  commentCount: number;
}

const author = {
  author: users.githubLogin,
  authorAvatar: users.avatarUrl,
};

/** Screened, open ideas (or built ones), ranked. */
export async function listBoard(db: DbOrTx, sort: BoardSort, limit = 50, offset = 0): Promise<BoardItem[]> {
  const commentCount = sql<number>`(select count(*)::int from ${comments} c where c.idea_id = ${ideas.id} and c.hidden_at is null)`;
  const base = db
    .select({
      id: ideas.id,
      title: ideas.title,
      status: ideas.status,
      voteCount: ideas.voteCount,
      createdAt: ideas.createdAt,
      ...author,
      commentCount,
    })
    .from(ideas)
    .innerJoin(users, eq(users.id, ideas.authorId));
  const visible = isNull(ideas.hiddenAt);
  const screened = sql`(${ideas.screenVerdict} ->> 'allowed')::boolean is true`;
  if (sort === "built") {
    return base
      .where(and(visible, eq(ideas.status, "deployed")))
      .orderBy(desc(ideas.decidedAt))
      .limit(limit)
      .offset(offset);
  }
  const live = and(visible, screened, inArray(ideas.status, ["open", "frozen", "building"]));
  return base
    .where(live)
    .orderBy(...(sort === "top" ? [desc(ideas.voteCount), asc(ideas.createdAt)] : [desc(ideas.createdAt)]))
    .limit(limit)
    .offset(offset);
}

/** The idea that would be frozen if the cycle ran now. */
export async function topOpenIdea(db: DbOrTx, excludeIds: number[] = []) {
  const [row] = await db
    .select()
    .from(ideas)
    .where(
      and(
        eq(ideas.status, "open"),
        isNull(ideas.hiddenAt),
        sql`(${ideas.screenVerdict} ->> 'allowed')::boolean is true`,
        excludeIds.length ? notInArray(ideas.id, excludeIds) : undefined,
      ),
    )
    .orderBy(desc(ideas.voteCount), asc(ideas.createdAt))
    .limit(1);
  return row;
}

export async function getIdea(db: DbOrTx, id: number, viewerId?: number) {
  const [row] = await db
    .select({ idea: ideas, ...author })
    .from(ideas)
    .innerJoin(users, eq(users.id, ideas.authorId))
    .where(eq(ideas.id, id));
  if (!row) return undefined;
  const thread = await db
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt, hiddenAt: comments.hiddenAt, ...author })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.ideaId, id))
    .orderBy(asc(comments.createdAt));
  const [mine] = viewerId
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(votes)
        .where(and(eq(votes.ideaId, id), eq(votes.userId, viewerId)))
    : [{ n: 0 }];
  const [voters] = await db
    .select({ n: sql<number>`count(distinct ${votes.userId})::int` })
    .from(votes)
    .where(eq(votes.ideaId, id));
  const build = await db.select().from(builds).where(eq(builds.ideaId, id)).orderBy(desc(builds.createdAt)).limit(1);
  return {
    ...row.idea,
    author: row.author,
    authorAvatar: row.authorAvatar,
    comments: thread.map((c) => (c.hiddenAt ? { ...c, body: "" } : c)),
    myVotes: mine?.n ?? 0,
    voters: voters?.n ?? 0,
    build: build[0],
  };
}

/**
 * Screens a freshly posted idea. Allowed → it appears on the board. Rejected → the author
 * gets their vote back. If the API fails, the idea stays unscreened and the worker retries later.
 */
export async function screenAndApply(db: Database, ideaId: number): Promise<"allowed" | "rejected" | "error"> {
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) return "error";
  if (idea.screenVerdict || idea.status !== "open") return idea.screenVerdict?.allowed ? "allowed" : "rejected";
  // Today's budget is spent: leave it unscreened; the worker retries after 00:00 UTC.
  if ((await budgetLeftTodayCents(db)) <= 0) return "error";
  let result;
  try {
    result = await screenIdea(idea);
  } catch (error) {
    console.error(`screen: idea ${ideaId} failed:`, error);
    return "error";
  }
  await chargeScreening(db, usdToCents(result.costUsd), `Screening idea ${ideaId}`);
  if (result.verdict.allowed) {
    await db.update(ideas).set({ screenVerdict: result.verdict }).where(and(eq(ideas.id, ideaId), isNull(ideas.screenVerdict)));
    return "allowed";
  }
  await rejectAtScreening(db, ideaId, result.verdict);
  await audit(db, null, "screen_reject", `idea:${ideaId}`, { category: result.verdict.category, reason: result.verdict.reason });
  return "rejected";
}

/** Ideas posted but not yet screened (the API was down). The worker calls this periodically. */
export async function unscreenedIdeaIds(db: DbOrTx): Promise<number[]> {
  const rows = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.status, "open"), isNull(ideas.screenVerdict)))
    .orderBy(asc(ideas.createdAt))
    .limit(20);
  return rows.map((r) => r.id);
}

export const COMMENT_MAX = 2_000;
const COMMENT_WINDOW_MIN = 10;
const COMMENTS_PER_WINDOW = 5;

export async function addComment(db: Database, userId: number, ideaId: number, raw: string) {
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (!body) throw new RuleError("invalid", "Say something.");
  if (body.length > COMMENT_MAX) throw new RuleError("invalid", `Comments are at most ${COMMENT_MAX} characters.`);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.bannedAt) throw new RuleError("banned", "This account is suspended.");
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea || idea.hiddenAt) throw new RuleError("not_found", "No such idea.");
  const since = new Date(Date.now() - COMMENT_WINDOW_MIN * 60_000);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.userId, userId), gte(comments.createdAt, since)));
  if ((recent?.n ?? 0) >= COMMENTS_PER_WINDOW) {
    throw new RuleError("invalid", "You're commenting a lot. Take a breath and try again in a few minutes.");
  }
  const [row] = await db.insert(comments).values({ ideaId, userId, body }).returning();
  return row!;
}
