# chat

Slack 에서 Multica 에이전트와 대화하는 기능. Multica 서버에 내장된 Slack 연동(`server/internal/integrations/slack`)이 하던 일을 이 프로세스로 옮겼다. Slack 앱 하나를 Multica 서버와 multica-slack 이 같이 쓰려면 소켓을 한쪽만 열어야 해서 옮겼다.

## 하는 일

| Slack 에서 | 결과 |
|---|---|
| 봇과의 DM 에 메시지 | `CHAT_AGENT_ID` 에이전트와의 Multica 채팅으로 들어가고, 답이 같은 DM 에 올라온다 |
| 채널이나 여러 명 DM 에서 봇 멘션 | 그 스레드가 채팅 하나가 된다. 최상위 멘션이면 그 메시지가 스레드 루트다 |
| 메시지 첫 줄 `/new`, `/clear` | 새 채팅으로 바꾼다. 같은 메시지에 내용이 더 있으면 새 채팅의 첫 메시지로 보낸다 |
| 메시지 첫 줄 `/issue 제목` (다음 줄부터 설명) | 이슈를 바로 만들고 담당을 에이전트로 둔다. 채팅 실행은 하지 않는다 |
| 슬래시 커맨드 `/issue 요청` | 에이전트가 요청을 읽고 이슈를 만든다(Multica quick create) |
| 슬래시 커맨드 `/new`, `/clear` | 봇 DM 에서만 새 채팅을 연다. 채널에서는 스레드 멘션으로 하라고 안내한다 |

처리하는 동안 사람이 보낸 메시지에 👀 반응을 달고 답을 올리면 걷는다. 멘션 없이 스레드에 이어 쓴 메시지는 서버 연동처럼 받지 않는다.

## Multica 서버 연동과 다른 점

- 세션과 이슈는 서비스 토큰 계정 명의로 만들어진다. 공개 API 에는 다른 사람 명의로 채팅을 여는 경로가 없다. 대신 말을 건 사람을 Slack 프로필 이메일로 Multica 멤버에서 찾아, 채팅 메시지 맨 앞과 이슈 설명 끝에 `[@이름](mention://member/<user_id>)` 멘션과 Slack 원문 링크로 남긴다. 멘션된 사람은 Multica 알림을 받는다.
- 계정 연결 카드가 없다. 서버 연동은 Slack 사용자를 Multica 계정에 따로 연결하게 했지만 여기서는 이메일이 같은 멤버를 찾는다. 못 찾으면 쓸 수 없다고 답한다.
- `/clear` 도 새 채팅을 연다. 서버 연동의 `/clear` 는 같은 채팅에서 맥락만 비우는데 그 동작이 공개 API 에 없다.
- 채팅이 Slack 에서 왔다는 표시가 에이전트에게 가지 않는다. 서버 연동은 `chat_channel_type=slack` 을 에이전트 프롬프트에 넣지만 공개 API 로 만든 채팅에는 없다. Slack 형식에 맞춘 답이 필요하면 에이전트 지침에 적는다.
- 첨부 파일은 옮기지 않는다. 파일 이름과 Slack 링크만 메시지에 붙인다.
- 답은 주기적으로 읽어 온다. 보낸 메시지의 `task_id` 와 같은 assistant 메시지가 생길 때까지 세션 메시지를 읽는다(처음 1분은 2초, 그 뒤 5초 간격, 최대 `CHAT_REPLY_TIMEOUT_MIN` 분). 기다리는 중에 프로세스가 재시작되면 그 답은 Multica 채팅에만 남는다.

## 세션 연결

DB 는 따로 두지 않는다. 봇이 올리는 답에 Slack message metadata(`event_type: multica_chat_session`, `session_id`, `agent_id`)를 실어 둔다. 메모리 캐시에 없으면 그 스레드(`conversations.replies`)나 DM(`conversations.history`)의 봇 메시지에서 가장 최근 세션을 다시 읽는다. 보낼 때 세션이 보관됐거나 지워졌으면 새 세션을 만들어 한 번 더 보낸다.

## 환경변수

| 이름 | 값 |
|---|---|
| `CHAT_AGENT_ID` | 대화할 Multica 에이전트 ID. 비우면 chat 기능을 켜지 않는다 |
| `CHAT_TYPING_EMOJI` | 처리 중 반응 이모지 이름. 기본 `eyes`, 빈 값이면 반응을 달지 않는다 |
| `CHAT_REPLY_TIMEOUT_MIN` | 답을 기다리는 최대 시간(분). 기본 30 |

`MULTICA_TOKEN` 계정이 `CHAT_AGENT_ID` 에이전트를 호출할 수 있어야 한다. 비공개 에이전트라면 그 계정 권한부터 본다.

## Slack 앱 설정

[chat.manifest-patch.json](chat.manifest-patch.json) 의 스코프, 이벤트, 슬래시 커맨드를 기존 설정에 더하고 앱을 다시 설치한다. Socket Mode 라면 슬래시 커맨드에 URL 은 필요 없다.

## Multica 서버 Slack 연동에서 옮겨 올 때

1. 그 Slack 설치가 묶인 에이전트 ID 를 `CHAT_AGENT_ID` 로 쓴다. `GET /api/workspaces/{id}/slack/installations` 응답의 `agent_id` 다.
2. 그 Slack 앱에 위 manifest 항목을 더하고 다시 설치한다. 봇 토큰과 app-level 토큰은 multica-slack 환경변수에 넣는다.
3. Multica 에서 그 Slack 설치를 끊는다(`DELETE /api/workspaces/{id}/slack/installations/{installationId}`). 안 끊으면 두 프로세스가 같은 앱에 소켓을 열어 이벤트가 나뉜다.
4. multica-slack 을 띄우고 DM, 채널 멘션, `/new`, `/issue` 를 하나씩 확인한다.

되돌리려면 multica-slack 을 내리고 Multica 에서 Slack 을 다시 설치한다. 서버 연동으로 만든 채팅은 원래 주인에게 그대로 있다. multica-slack 으로 만든 채팅은 서비스 계정 채팅 목록에 남는다.

## 점검

```bash
node scripts/chat/self-test.js    # 명령 해석, 라우팅, 분할 같은 순수 함수
node scripts/chat/check-api.js    # Multica API 읽기 점검(세션·이슈를 만들지 않음)
```
