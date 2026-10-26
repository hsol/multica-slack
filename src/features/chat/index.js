// chat: Slack 에서 Multica 에이전트와 대화한다. Multica 서버 내장 Slack 연동(server/internal/integrations/slack)을
// 이 프로세스로 옮긴 것이다. Slack 앱 소켓을 이 프로세스 하나만 물게 하려고 옮겼다.
//
// - DM 의 모든 메시지, 채널의 봇 멘션 -> CHAT_AGENT_ID 에이전트와의 Multica 채팅
// - 메시지 첫 줄 /new, /clear      -> 새 채팅으로 바꾼다
// - 메시지 첫 줄 /issue 제목       -> 이슈를 바로 만든다(담당: 에이전트)
// - 슬래시 커맨드 /issue, /new, /clear
//
// 서버 연동과 다른 점: 세션과 이슈는 서비스 토큰 계정 명의로 만들어진다. 말을 건 사람은 Slack 이메일로
// Multica 멤버를 찾아 본문 멘션으로 남긴다. 자세한 내용은 docs/chat.md

import { memberByEmail, memberMention, sendChatMessage, createIssue, quickCreateIssue, issueUrl } from '../../lib/multica.js';
import { parseControl, parseIssue, TEXT } from './commands.js';
import { createSessionStore, route, sessionMetadata } from './sessions.js';
import { deliverReply, postMarkdown } from './reply.js';

export const name = 'chat';

const AGENT_ID = process.env.CHAT_AGENT_ID;
const TYPING_EMOJI = process.env.CHAT_TYPING_EMOJI ?? 'eyes';
const INGESTABLE_SUBTYPES = new Set([undefined, '', 'thread_broadcast', 'file_share']);

// 소켓 재연결 때 같은 이벤트가 다시 올 수 있다
const seen = new Map();
function firstTime(channel, ts) {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 10 * 60 * 1000) seen.delete(k);
  const key = `${channel}:${ts}`;
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

function cleanText(text, botUserId) {
  let t = String(text || '');
  if (botUserId) t = t.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '');
  return t.trim();
}

// 파일은 아직 Multica 첨부로 옮기지 않는다. 에이전트가 알 수 있게 이름과 링크만 붙인다
function fileNote(files) {
  if (!files?.length) return '';
  return '\n\n첨부(Slack): ' + files.map((f) => `${f.name || f.title || f.id}${f.permalink ? ` (${f.permalink})` : ''}`).join(', ');
}

async function permalink(client, channel, ts) {
  return (await client.chat.getPermalink({ channel, message_ts: ts }).catch(() => null))?.permalink;
}

// 세션이 보관됐거나(400) 지워졌거나(404) 서비스 계정 것이 아니면(403) 새 세션으로 한 번 다시 보낸다
const SESSION_GONE = /-> (400|403|404) /;

export function register(app, { slackUsers }) {
  if (!AGENT_ID) {
    app.logger.warn('CHAT_AGENT_ID 가 비어 있어 chat 기능을 켜지 않는다');
    return;
  }
  const sessions = createSessionStore({ agentId: AGENT_ID });
  const say = (client, r, text, metadata) => postMarkdown(client, { channel: r.channel, threadTs: r.replyThread, text, metadata });
  const memberFor = async (userId) => memberByEmail(await slackUsers.emailForId(userId)).catch(() => null);

  async function send({ client, logger, r, sessionId, content, userTs }) {
    let sid = sessionId;
    let sent;
    try {
      sent = await sendChatMessage(sid, content);
    } catch (e) {
      if (!SESSION_GONE.test(e.message)) throw e;
      logger.info(`chat session ${sid} unusable, rotating: ${e.message}`);
      sid = await sessions.rotate(r);
      sent = await sendChatMessage(sid, content);
    }
    deliverReply({ client, logger, agentId: AGENT_ID, sessionId: sid, taskId: sent.task_id, r, userTs, typingEmoji: TYPING_EMOJI });
  }

  async function handleIssue({ client, logger, r, member, issue, channel, ts }) {
    if (!issue.title) return say(client, r, TEXT.issueUsage);
    const link = await permalink(client, channel, ts);
    const requester = `요청자: ${memberMention(member)}${link ? ` · [Slack](${link})` : ''}`;
    try {
      const created = await createIssue({
        title: issue.title,
        description: [issue.description, requester].filter(Boolean).join('\n\n'),
        status: 'todo',
        priority: 'none',
        assignee_type: 'agent',
        assignee_id: AGENT_ID,
      });
      const url = await issueUrl(created.identifier);
      const label = `${created.identifier} ${created.title}`;
      await say(client, r, `✅ 이슈를 만들었어요: ${url ? `[${label}](${url})` : label}`);
    } catch (e) {
      logger.error(`chat /issue failed: ${e.message}`);
      await say(client, r, `⚠️ 이슈를 만들지 못했어요. ${e.message.slice(0, 200)}`);
    }
  }

  async function handle({ client, logger, context, channel, user, text, ts, threadTs, files, isDm }) {
    if (!firstTime(channel, ts)) return;
    const r = route({ channel, ts, threadTs, isDm });
    const member = await memberFor(user);
    if (!member) return say(client, r, TEXT.notMember);

    let body = cleanText(text, context.botUserId);
    let sessionId;
    const control = parseControl(body);
    if (control) {
      sessionId = await sessions.rotate(r);
      if (!control.body && !files?.length) {
        return say(client, r, control.kind === 'new' ? TEXT.chatStarted : TEXT.chatCleared, sessionMetadata(sessionId, AGENT_ID));
      }
      body = control.body;
    } else {
      const issue = parseIssue(body);
      if (issue) return handleIssue({ client, logger, r, member, issue, channel, ts });
    }
    if (!body && !files?.length) return;

    sessionId ||= (await sessions.resolve(client, r)).sessionId;
    const link = await permalink(client, channel, ts);
    const content = `${memberMention(member)}${link ? ` · [Slack](${link})` : ''}\n\n${body}${fileNote(files)}`;
    if (TYPING_EMOJI) await client.reactions.add({ channel, timestamp: ts, name: TYPING_EMOJI }).catch(() => {});
    try {
      await send({ client, logger, r, sessionId, content, userTs: ts });
    } catch (e) {
      logger.error(`chat send failed: ${e.message}`);
      if (TYPING_EMOJI) await client.reactions.remove({ channel, timestamp: ts, name: TYPING_EMOJI }).catch(() => {});
      await say(client, r, TEXT.sendFailed);
    }
  }

  // 채널(공개·비공개)과 여러 명 DM 에서는 멘션만 받는다. 멘션 없는 스레드 후속 메시지는 서버 연동과 같이 무시한다
  app.event('app_mention', async ({ event, client, logger, context }) => {
    if (event.bot_id || !event.user) return;
    await handle({ client, logger, context, channel: event.channel, user: event.user, text: event.text, ts: event.ts, threadTs: event.thread_ts, files: event.files, isDm: false });
  });

  // 봇과의 1:1 DM 은 모든 메시지를 받는다
  app.event('message', async ({ event, client, logger, context }) => {
    if (event.channel_type !== 'im') return;
    if (event.bot_id || !event.user || event.user === context.botUserId || !INGESTABLE_SUBTYPES.has(event.subtype)) return;
    await handle({ client, logger, context, channel: event.channel, user: event.user, text: event.text, ts: event.ts, threadTs: event.thread_ts, files: event.files, isDm: true });
  });

  // 슬래시 /issue: 에이전트가 자연어 요청을 읽고 이슈를 만든다(서버 연동의 quick create 와 같다)
  app.command('/issue', async ({ command, ack, respond, logger }) => {
    await ack();
    const prompt = (command.text || '').trim();
    if (!prompt) return respond({ response_type: 'ephemeral', text: TEXT.slashUsage });
    const member = await memberFor(command.user_id);
    if (!member) return respond({ response_type: 'ephemeral', text: TEXT.notMember });
    try {
      await quickCreateIssue({
        agent_id: AGENT_ID,
        prompt: `${prompt}\n\n---\n요청자: ${memberMention(member)} (Slack /issue). 만드는 이슈 설명 마지막 줄에 이 요청자 멘션을 그대로 남겨 주세요.`,
      });
      await respond({ response_type: 'ephemeral', text: TEXT.slashQueued });
    } catch (e) {
      logger.error(`slash /issue failed: ${e.message}`);
      await respond({ response_type: 'ephemeral', text: `⚠️ 이슈 요청을 넣지 못했어요. ${e.message.slice(0, 200)}` });
    }
  });

  // 슬래시 /new, /clear: 봇 DM 에서만. 채널에서는 스레드 멘션으로 안내한다
  for (const kind of ['new', 'clear']) {
    app.command(`/${kind}`, async ({ command, ack, respond, client, logger }) => {
      await ack();
      if (!command.channel_id.startsWith('D')) return respond({ response_type: 'ephemeral', text: TEXT.newThreadGuide });
      const member = await memberFor(command.user_id);
      if (!member) return respond({ response_type: 'ephemeral', text: TEXT.notMember });
      const r = route({ channel: command.channel_id, isDm: true });
      try {
        const sessionId = await sessions.rotate(r);
        const posted = await say(client, r, kind === 'new' ? TEXT.chatStarted : TEXT.chatCleared, sessionMetadata(sessionId, AGENT_ID));
        const body = (command.text || '').trim();
        if (body) await send({ client, logger, r, sessionId, content: `${memberMention(member)} · Slack\n\n${body}`, userTs: posted?.ts });
      } catch (e) {
        logger.error(`slash /${kind} failed: ${e.data?.error || e.message}`);
        await respond({ response_type: 'ephemeral', text: `⚠️ 새 채팅을 열지 못했어요. ${e.data?.error || e.message}` });
      }
    });
  }
}
