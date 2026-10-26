// chat 기능이 쓰는 Multica API 를 읽기 전용으로 점검한다(세션·이슈를 만들지 않는다).
// node scripts/chat/check-api.js
import { workspaceSlug, listChatMessages } from '../../src/lib/multica.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const cfg = (() => { try { return JSON.parse(readFileSync(`${homedir()}/.multica/config.json`, 'utf8')); } catch { return {}; } })();
const SERVER = (process.env.MULTICA_SERVER_URL || cfg.server_url || '').replace(/\/$/, '');
const headers = { Authorization: `Bearer ${process.env.MULTICA_TOKEN || cfg.token}`, 'X-Workspace-ID': process.env.MULTICA_WORKSPACE_ID || cfg.workspace_id };
const get = async (p) => (await fetch(SERVER + p, { headers })).json();

console.log('workspace slug:', await workspaceSlug());
const agentId = process.env.CHAT_AGENT_ID;
const agents = await get('/api/agents');
const list = Array.isArray(agents) ? agents : agents.agents || [];
console.log('agents:', list.map((a) => `${a.name}=${a.id}`).join(', '));
if (agentId) console.log('CHAT_AGENT_ID ->', list.find((a) => a.id === agentId)?.name || '(없음)');

const sessions = await get('/api/chat/sessions');
const arr = Array.isArray(sessions) ? sessions : sessions.sessions || sessions.items || [];
console.log('chat sessions visible to token:', arr.length);
if (arr[0]) {
  const msgs = await listChatMessages(arr[0].id);
  const a = msgs.find((m) => m.role === 'assistant');
  console.log('sample assistant message keys:', a ? Object.keys(a).join(',') : '(none)');
}
