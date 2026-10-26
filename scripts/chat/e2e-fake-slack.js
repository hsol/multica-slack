// Slack 없이 chat 기능 한 바퀴를 돌린다. Multica 는 실제 서버를 쓴다(채팅 세션 1개와 에이전트 실행 1회가 생긴다).
// CHAT_AGENT_ID=<에이전트> TEST_EMAIL=<멤버 이메일> node scripts/chat/e2e-fake-slack.js
import * as chat from '../../src/features/chat/index.js';

const posted = [];
const handlers = {};
const client = {
  chat: {
    postMessage: async (m) => { posted.push(m); console.log('[slack post]', JSON.stringify({ text: m.text, thread_ts: m.thread_ts, metadata: m.metadata })); return { ts: String(Date.now() / 1000) }; },
    getPermalink: async () => ({ permalink: 'https://example.slack.com/archives/D000/p1' }),
  },
  reactions: { add: async (r) => console.log('[slack react+]', r.name), remove: async (r) => console.log('[slack react-]', r.name) },
  conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
};
const app = { logger: console, event: (n, fn) => { handlers[n] = fn; }, command: () => {} };
chat.register(app, { slackUsers: { emailForId: async () => process.env.TEST_EMAIL } });

const ts = String(Date.now() / 1000);
await handlers.message({
  event: { channel_type: 'im', channel: 'D000', user: 'U000', text: process.env.TEST_TEXT || '연결 테스트예요. "ok" 한 단어로만 답해 주세요.', ts },
  client, logger: console, context: { botUserId: 'UBOT' },
});
const deadline = Date.now() + 10 * 60 * 1000;
while (!posted.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
console.log(posted.length ? 'e2e ok' : 'e2e timeout');
process.exit(0);
