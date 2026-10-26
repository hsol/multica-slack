// Slack 대화 위치 <-> Multica 채팅 세션 연결.
//
// 라우팅은 Multica 서버 Slack 연동(slackSessionRouting)과 같다
// - DM: 대화방 하나 = 세션 하나 (/new 로 바꾼다)
// - 채널: 스레드 하나 = 세션 하나. 최상위 멘션은 그 메시지가 스레드 루트가 된다
//
// 연결 정보는 따로 DB 에 두지 않는다. 봇이 올리는 답글에 Slack message metadata 로 세션 id 를 실어 두고,
// 재시작 뒤에는 그 대화(스레드/DM)의 봇 메시지에서 다시 읽는다. 메모리 캐시는 그 조회를 줄이는 용도다.

import { createChatSession } from '../../lib/multica.js';

export const EVENT_TYPE = 'multica_chat_session';

export function route({ channel, ts, threadTs, isDm }) {
  if (isDm) return { key: channel, channel, replyThread: threadTs || undefined, isDm };
  const root = threadTs || ts;
  return { key: `${channel}:${root}`, channel, replyThread: root, isDm };
}

export function sessionMetadata(sessionId, agentId) {
  return { event_type: EVENT_TYPE, event_payload: { session_id: sessionId, agent_id: agentId } };
}

export function createSessionStore({ agentId }) {
  const cache = new Map(); // key -> sessionId
  const inflight = new Map(); // key -> Promise<sessionId> (동시에 온 첫 메시지가 세션을 둘 만들지 않도록)

  function pick(messages) {
    for (const m of messages) {
      const md = m.metadata;
      if (md?.event_type === EVENT_TYPE && md.event_payload?.agent_id === agentId && md.event_payload.session_id) {
        return md.event_payload.session_id;
      }
    }
    return null;
  }

  // Slack 대화에서 가장 최근 세션 표시를 찾는다
  async function lookup(client, r) {
    try {
      if (r.isDm) {
        // conversations.history 는 최신순
        const res = await client.conversations.history({ channel: r.channel, limit: 200, include_all_metadata: true });
        return pick(res.messages || []);
      }
      const res = await client.conversations.replies({ channel: r.channel, ts: r.replyThread, limit: 200, include_all_metadata: true });
      return pick([...(res.messages || [])].reverse()); // replies 는 오래된 순
    } catch {
      return null;
    }
  }

  async function create(r) {
    const s = await createChatSession(agentId);
    cache.set(r.key, s.id);
    return s.id;
  }

  // 있으면 기존 세션, 없으면 새로 만든다. { sessionId, created }
  async function resolve(client, r) {
    if (cache.has(r.key)) return { sessionId: cache.get(r.key), created: false };
    if (inflight.has(r.key)) return { sessionId: await inflight.get(r.key), created: false };
    const p = (async () => {
      const found = await lookup(client, r);
      if (found) {
        cache.set(r.key, found);
        return { sessionId: found, created: false };
      }
      return { sessionId: await create(r), created: true };
    })();
    inflight.set(r.key, p.then((v) => v.sessionId));
    try {
      return await p;
    } finally {
      inflight.delete(r.key);
    }
  }

  // /new, /clear, 또는 기존 세션이 보관·삭제돼 메시지를 못 보낼 때
  async function rotate(r) {
    return create(r);
  }

  return { resolve, rotate };
}
