// Multica REST client: issue lookup + assignee/project name resolution with a small TTL cache.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// 접속 정보는 환경변수가 우선이고, 비어 있으면 multica CLI 설정(~/.multica/config.json)을 쓴다.
// CLI 로 로그인해 둔 개발 머신에서는 Slack 토큰만 있으면 된다.
const cliConfig = (() => {
  try {
    return JSON.parse(readFileSync(`${homedir()}/.multica/config.json`, 'utf8'));
  } catch {
    return {};
  }
})();
const SERVER = (process.env.MULTICA_SERVER_URL || cliConfig.server_url || '').replace(/\/$/, '');
const APP_URL = (process.env.MULTICA_APP_URL || cliConfig.app_url || SERVER).replace(/\/$/, '');
const TOKEN = process.env.MULTICA_TOKEN || cliConfig.token;
const WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || cliConfig.workspace_id;
const CACHE_TTL_MS = 10 * 60 * 1000;

// timeoutMs 기본값은 Slack 이벤트 3초 안에 끝내야 하는 조회용이다. 응답을 기다리지 않는 호출(채팅 등)은 늘려 쓴다
async function call(method, path, body, { timeoutMs = 2500 } = {}) {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Workspace-ID': WORKSPACE_ID,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`multica ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}
const get = (path) => call('GET', path);

const asList = (v, key) => (Array.isArray(v) ? v : (v && (v[key] || v.items || v.data)) || []);

let directory = { at: 0, members: new Map(), agents: new Map(), squads: new Map() };
async function loadDirectory() {
  if (Date.now() - directory.at < CACHE_TTL_MS) return directory;
  const [members, agents, squads] = await Promise.all([
    get(`/api/workspaces/${WORKSPACE_ID}/members`).catch(() => []),
    get('/api/agents').catch(() => []),
    get('/api/squads').catch(() => []),
  ]);
  directory = {
    at: Date.now(),
    // 이슈의 assignee_id 는 member.user_id 다 (member.id 아님)
    members: new Map(asList(members, 'members').map((m) => [m.user_id, m])),
    agents: new Map(asList(agents, 'agents').map((a) => [a.id, a])),
    squads: new Map(asList(squads, 'squads').map((s) => [s.id, s])),
  };
  return directory;
}

export async function resolveActor(type, id) {
  if (!type || !id) return null;
  const d = await loadDirectory();
  if (type === 'member') {
    const m = d.members.get(id);
    return m ? { kind: 'member', name: m.name, email: m.email } : null;
  }
  if (type === 'agent') {
    const a = d.agents.get(id);
    return a ? { kind: 'agent', name: a.name } : null;
  }
  if (type === 'squad') {
    const s = d.squads.get(id);
    return s ? { kind: 'squad', name: s.name } : null;
  }
  return null;
}

const projectCache = new Map();
export async function projectTitle(id) {
  if (!id) return null;
  const hit = projectCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.title;
  const p = await get(`/api/projects/${id}`).catch(() => null);
  const title = p?.title || null;
  projectCache.set(id, { at: Date.now(), title });
  return title;
}

export function getIssue(ref) {
  return get(`/api/issues/${encodeURIComponent(ref)}`);
}

// 쓰기는 서비스 토큰 하나로 한다. 실제로 누른 사람은 memberByEmail 로 멤버 여부를 확인하고
// 변경 이력 댓글에 남긴다.
export function updateIssue(id, patch) {
  return call('PUT', `/api/issues/${encodeURIComponent(id)}`, patch);
}

export function addComment(id, content) {
  return call('POST', `/api/issues/${encodeURIComponent(id)}/comments`, { content });
}

// 이슈 댓글 전체(시간순, 답글은 parent_id 로 연결). 페이지 나누기는 호출하는 쪽에서 한다
export async function listComments(id) {
  const v = await get(`/api/issues/${encodeURIComponent(id)}/comments`);
  return asList(v, 'comments').filter((c) => !c.deleted_at);
}

export function addReply(id, parentId, content) {
  return call('POST', `/api/issues/${encodeURIComponent(id)}/comments`, { content, parent_id: parentId });
}

export async function memberByName(name) {
  const d = await loadDirectory();
  for (const m of d.members.values()) if (m.name === name) return m;
  return null;
}

export async function memberByEmail(email) {
  if (!email) return null;
  const d = await loadDirectory();
  const lower = email.toLowerCase();
  for (const m of d.members.values()) if ((m.email || '').toLowerCase() === lower) return m;
  return null;
}

let statusCache = { at: 0, list: [] };
export async function issueStatuses() {
  if (Date.now() - statusCache.at < CACHE_TTL_MS && statusCache.list.length) return statusCache.list;
  const v = await get('/api/issue-statuses').catch(() => null);
  const list = asList(v, 'statuses').map((s) => ({ key: s.key, name: s.name, category: s.category }));
  statusCache = { at: Date.now(), list };
  return list;
}

// ---- 채팅 (chat 기능) ----
// 세션과 메시지는 서비스 토큰 계정 명의로 만들어진다. 실제로 말을 건 사람은 메시지 본문의 멘션으로 남긴다

const SLOW = { timeoutMs: 15000 };

export function createChatSession(agentId) {
  return call('POST', '/api/chat/sessions', { agent_id: agentId }, SLOW);
}

// 응답: { message_id, task_id, queued, ... }
export function sendChatMessage(sessionId, content) {
  return call('POST', `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { content }, SLOW);
}

// 세션 전체 메시지(오래된 순, 맨 배열)
export async function listChatMessages(sessionId) {
  const v = await call('GET', `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, undefined, SLOW);
  return asList(v, 'messages');
}

export function createIssue(body) {
  return call('POST', '/api/issues', body, SLOW);
}

// 에이전트가 자연어 요청을 읽고 이슈를 만든다(비동기). 응답: { task_id }
export function quickCreateIssue(body) {
  return call('POST', '/api/issues/quick-create', body, SLOW);
}

let slugCache = null;
export async function workspaceSlug() {
  if (slugCache) return slugCache;
  const ws = await call('GET', `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}`, undefined, SLOW).catch(() => null);
  slugCache = ws?.slug || null;
  return slugCache;
}

export async function issueUrl(identifier) {
  const slug = await workspaceSlug();
  return slug && identifier ? `${APP_URL}/${slug}/issues/${identifier}` : null;
}

// Multica 마크다운 멘션. 이슈 설명·댓글·채팅 본문에 넣으면 그 멤버가 작성자로 남고 알림을 받는다
export function memberMention(member) {
  return `[@${member.name}](mention://member/${member.user_id})`;
}

export const multicaServer = SERVER;
export const multicaAppUrl = APP_URL;

// 시작 시 확인용. 비어 있는 필수 값 이름을 돌려준다
export function missingMulticaConfig() {
  return Object.entries({ MULTICA_SERVER_URL: SERVER, MULTICA_WORKSPACE_ID: WORKSPACE_ID, MULTICA_TOKEN: TOKEN })
    .filter(([, v]) => !v)
    .map(([k]) => k);
}
