// chat 기능의 순수 함수 점검. Slack·Multica 접속 없이 돈다: node scripts/chat/self-test.js
import assert from 'node:assert/strict';
import { parseControl, parseIssue } from '../../src/features/chat/commands.js';
import { route } from '../../src/features/chat/sessions.js';
import { chunk, toSlackMarkdown } from '../../src/features/chat/reply.js';

assert.deepEqual(parseControl('/new'), { kind: 'new', body: '' });
assert.deepEqual(parseControl('\n  /clear 이어서\n둘째 줄'), { kind: 'clear', body: '이어서\n둘째 줄' });
assert.equal(parseControl('/newbie'), null);
assert.equal(parseControl('안녕 /new'), null);

assert.deepEqual(parseIssue('/issue 로그인 버튼 안 눌림\n사파리에서만\n'), { title: '로그인 버튼 안 눌림', description: '사파리에서만' });
assert.deepEqual(parseIssue('/issue'), { title: '', description: '' });
assert.equal(parseIssue('/issuetracker 보기'), null);

assert.deepEqual(route({ channel: 'D1', ts: '2', isDm: true }), { key: 'D1', channel: 'D1', replyThread: undefined, isDm: true });
assert.deepEqual(route({ channel: 'C1', ts: '2', isDm: false }), { key: 'C1:2', channel: 'C1', replyThread: '2', isDm: false });
assert.equal(route({ channel: 'C1', ts: '3', threadTs: '2', isDm: false }).key, 'C1:2');

assert.equal(toSlackMarkdown('담당 [@임한솔](mention://member/abc) 확인'), '담당 @임한솔 확인');
assert.deepEqual(chunk('a'.repeat(5) + '\n' + 'b'.repeat(5), 8), ['aaaaa', 'bbbbb']);
assert.equal(chunk('x'.repeat(25), 10).join(''), 'x'.repeat(25));

console.log('chat self-test ok');
