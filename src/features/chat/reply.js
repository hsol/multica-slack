// 에이전트 답을 기다렸다가 Slack 에 올린다.
// Multica 서버 Slack 연동은 내부 이벤트(chat:done)로 답을 받지만, 여기서는 REST 로 세션 메시지를 주기적으로 읽어
// 보낸 메시지의 task_id 와 같은 assistant 메시지가 생기면 그걸 올린다.

import { listChatMessages } from '../../lib/multica.js';
import { sessionMetadata } from './sessions.js';
import { TEXT } from './commands.js';

const TIMEOUT_MS = Number(process.env.CHAT_REPLY_TIMEOUT_MIN || 30) * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 처음 1분은 2초, 그 뒤로는 5초 간격
async function waitForAnswer(sessionId, taskId) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(Date.now() - started < 60_000 ? 2000 : 5000);
    let messages;
    try {
      messages = await listChatMessages(sessionId);
    } catch {
      continue; // 일시 오류는 다음 주기에 다시 본다
    }
    const hit = messages.find((m) => m.role === 'assistant' && m.task_id === taskId);
    if (hit) return hit;
  }
  return null;
}

// Multica 멘션 링크 [@이름](mention://...) 은 Slack 에서 열리지 않으니 글자만 남긴다
export function toSlackMarkdown(text) {
  return String(text || '').replace(/\[([^\]]+)\]\(mention:\/\/[^)]+\)/g, '$1');
}

// markdown 블록은 메시지 하나에 12,000자까지라 넉넉히 나눈다. 가능하면 줄바꿈에서 자른다
export function chunk(text, size = 11000) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export async function postMarkdown(client, { channel, threadTs, text, metadata }) {
  const parts = chunk(toSlackMarkdown(text));
  let first;
  for (const [i, part] of parts.entries()) {
    const res = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: part.slice(0, 3000),
      blocks: [{ type: 'markdown', text: part }],
      ...(i === 0 && metadata ? { metadata } : {}),
    });
    first ||= res;
  }
  return first;
}

// 보낸 메시지(taskId)의 답을 기다려 올리고, 처리 중 표시(👀)를 걷는다. 기다리는 동안 이벤트 처리는 막지 않는다
export function deliverReply({ client, logger, agentId, sessionId, taskId, r, userTs, typingEmoji }) {
  (async () => {
    const answer = await waitForAnswer(sessionId, taskId);
    const metadata = sessionMetadata(sessionId, agentId);
    try {
      if (!answer) {
        await postMarkdown(client, { channel: r.channel, threadTs: r.replyThread, text: TEXT.replyTimeout, metadata });
      } else if (answer.failure_reason) {
        await postMarkdown(client, { channel: r.channel, threadTs: r.replyThread, text: `${TEXT.agentFailed}: ${answer.failure_reason}`, metadata });
      } else if (answer.message_kind !== 'no_response' && answer.content?.trim()) {
        await postMarkdown(client, { channel: r.channel, threadTs: r.replyThread, text: answer.content, metadata });
      }
    } catch (e) {
      logger.error(`chat reply post failed: ${e.data?.error || e.message}`);
    }
    if (typingEmoji) {
      await client.reactions.remove({ channel: r.channel, timestamp: userTs, name: typingEmoji }).catch(() => {});
    }
  })().catch((e) => logger.error(`chat reply failed: ${e.message}`));
}
