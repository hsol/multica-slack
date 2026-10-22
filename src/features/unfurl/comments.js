// Work Object 댓글 탭. 원본은 Multica 이슈 댓글 한 곳이고 Slack 은 보기 창으로만 쓴다.
// - 읽기: entity_comments_requested -> Multica 댓글 조회 -> entity.presentComments
// - 쓰기: Slack 에서 단 댓글은 Multica 댓글로 바로 쓴다. Slack 쪽에 사본을 두지 않는다.
// Slack 에서 쓴 댓글은 서비스 토큰으로 들어가므로 본문 앞에 "[Slack · 이름]" 을 붙이고,
// 보여줄 때는 이 머리말을 걷어내 실제 작성자로 표시한다.

import { listComments, resolveActor, memberByName } from '../../lib/multica.js';

const SLACK_TAG_RE = /^\[Slack · ([^\]]+)\]\s*/;
const toEpoch = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined);

export function commentSummary(comments) {
  const roots = comments.filter((c) => !c.parent_id);
  const latest = comments.reduce((m, c) => Math.max(m, toEpoch(c.created_at) || 0), 0);
  return { count: roots.length, ...(latest ? { latest_timestamp: latest } : {}) };
}

async function sender(comment, lookupSlackUser, nameToMember) {
  const tagged = comment.content?.match(SLACK_TAG_RE);
  if (tagged) {
    const member = nameToMember(tagged[1]);
    const slackId = member?.email && (await lookupSlackUser(member.email));
    return slackId ? { user_id: slackId } : { text: tagged[1] };
  }
  const actor = await resolveActor(comment.author_type, comment.author_id);
  if (actor?.kind === 'member' && actor.email) {
    const slackId = await lookupSlackUser(actor.email);
    if (slackId) return { user_id: slackId };
  }
  const suffix = actor?.kind === 'agent' ? ' (agent)' : '';
  return { text: (actor?.name || comment.author_type) + suffix };
}

export async function presentComments({ client, event, issueUrl, lookupSlackUser, member, logger }) {
  const all = await listComments(event.external_ref.id);
  const scope = event.thread_root_id
    ? all.filter((c) => c.parent_id === event.thread_root_id)
    : all.filter((c) => !c.parent_id);
  // Multica 는 오래된 순. 댓글 탭은 최신이 아래로 오는 대화 형태라 그대로 두고, 앞쪽(과거)을 커서로 넘긴다
  const limit = Math.min(Number(event.limit) || 50, 100);
  const end = event.cursor ? Number(event.cursor) : scope.length;
  const start = Math.max(0, end - limit);
  const page = scope.slice(start, end);

  const nameIndex = new Map();
  const nameToMember = (name) => nameIndex.get(name);
  // "[Slack · 이름]" 머리말의 이름을 멤버로 되돌리기 위한 색인
  await Promise.all(
    [...new Set(page.map((c) => c.content?.match(SLACK_TAG_RE)?.[1]).filter(Boolean))].map(async (n) => {
      const m = await memberByName(n);
      if (m) nameIndex.set(n, m);
    }),
  );

  const replyCount = (id) => all.filter((c) => c.parent_id === id).length;
  const comments = await Promise.all(
    page.map(async (c) => {
      const replies = event.thread_root_id ? 0 : replyCount(c.id);
      const latestReply = replies
        ? all.filter((r) => r.parent_id === c.id).reduce((m, r) => Math.max(m, toEpoch(r.created_at) || 0), 0)
        : undefined;
      return {
        id: c.id,
        url: `${issueUrl}#comment-${c.id}`,
        timestamp: toEpoch(c.created_at),
        sender: await sender(c, lookupSlackUser, nameToMember),
        comment: { value: (c.content || '').replace(SLACK_TAG_RE, '').slice(0, 3000) || '(내용 없음)', format: 'markdown' },
        can_edit: false,
        can_delete: false,
        can_reply: Boolean(member) && !event.thread_root_id,
        ...(replies ? { reply_count: replies, latest_reply_ts: latestReply } : {}),
        ...(c.updated_at && c.updated_at !== c.created_at ? { last_edit_ts: toEpoch(c.updated_at) } : {}),
        ...(event.thread_root_id ? { thread_root_id: event.thread_root_id } : {}),
      };
    }),
  );

  const res = await client.apiCall('entity.presentComments', {
    trigger_id: event.trigger_id,
    comments,
    can_post_comment: Boolean(member),
    ...(start > 0 ? { cursor: String(start) } : {}),
  });
  logger.info(`presentComments ${event.external_ref.id} ${comments.length}/${scope.length}${event.thread_root_id ? ' (thread)' : ''}`);
  return res;
}
