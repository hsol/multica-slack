# unfurl

Slack 에 Multica 이슈 링크(`https://<multica 웹 주소>/<workspace>/issues/ABC-123`)가 올라오면 Work Object(task) 카드로 펼쳐 준다. 카드를 누르면 오른쪽 flexpane 에 설명, 작성자, 생성 시각과 수정 시각까지 나온다.

## Multica 서버 Slack 연동과 같은 앱을 쓰려면

Multica 서버의 Slack 연동은 Socket Mode 로 앱을 물고 있고 `link_shared` 를 처리하지 않는다. 같은 앱에 소켓을 하나 더 열면 Slack 이 이벤트를 두 연결 중 한 곳에만 보내서 멘션과 DM 이 빠진다. 그래서 한 앱에서 둘 다 쓰려면 서버 연동을 끊고 [chat](chat.md) 기능으로 대신한다. 서버 연동을 계속 쓸 거라면 이 프로세스는 별도 Slack 앱에 붙인다.

## 동작

| Slack 이벤트 | 처리 | Slack API |
|---|---|---|
| `message` | 봇 메시지까지 포함해 본문과 블록에서 이슈 URL 을 찾는다 | `chat.unfurl(channel, ts)` + `metadata.entities` |
| `link_shared` | 사람이 올린 링크. 같은 메시지는 `message` 쪽과 중복 처리하지 않는다 | `chat.unfurl(unfurl_id)` + `metadata.entities` |
| `entity_details_requested` | 같은 이슈를 다시 조회해 상세 필드 추가 | `entity.presentDetails` |
| `entity_comments_requested` | Multica 이슈 댓글 조회 | `entity.presentComments` |

카드 필드: 상태(색 태그), 담당자, 마감일, 우선순위, 프로젝트, 라벨.
flexpane 추가 필드: 설명(3000자 컷), 작성자, 생성 시각, 수정 시각.

- 담당자가 멤버면 `users.lookupByEmail` 로 Slack 유저를 찾아 실제 프로필로 보여준다. 에이전트와 스쿼드는 이름 뒤에 `(agent)`, `(squad)` 를 붙인다.
- `external_ref.id` 는 이슈 UUID 다. 이게 바뀌면 Slack 의 Related conversations 가 끊기므로 식별자(ABC-123) 대신 UUID 로 고정했다.
- 멤버, 에이전트, 스쿼드, 프로젝트 이름은 10분 캐시한다.

`link_shared` 는 다른 앱이 올린 메시지에는 오지 않는다. Multica 봇처럼 다른 앱이 올린 링크는 `message` 이벤트로 잡아 `channel` 과 `ts` 로 붙인다. 원 메시지가 `unfurl_links: false` 로 올라와도 이 방식은 붙는다. 이 Slack 앱이 들어가 있는 채널에서만 동작한다.

Slack 클라이언트는 처음 그린 카드를 캐시한다. 카드 모양을 바꿔도 예전 메시지는 Slack 이 새로고침(`link_shared` 의 `is_unfurl_refresh`)을 요청할 때까지 예전 모습으로 남는다.

## 버튼과 패널 편집

| 위치 | 동작 | Multica 쓰기 |
|---|---|---|
| 카드와 패널의 주 버튼 | 나에게 할당, 완료 처리 | `assignee_type=member` / `status=done` |
| 카드와 패널의 더보기 | `AGENT_TARGETS` 에 정한 에이전트나 스쿼드에 맡기기, Multica에서 열기 | `assignee_type=agent` 또는 `squad` (실행이 걸린다) |
| 우측 패널 연필 | 상태, 우선순위, 마감일 편집 | `PUT /api/issues/{id}` |

- 쓰기는 `MULTICA_TOKEN` 하나로 한다. 누른 사람은 Slack 이메일로 Multica 멤버인지 확인하고, 멤버가 아니면 거절한다.
- 바꿀 때마다 이슈에 `[Slack · 이름] 상태를 Done 으로 변경` 같은 댓글을 남긴다. Multica 의 작성자는 토큰 주인으로 찍히므로 실제로 누른 사람은 이 댓글로 남긴다. 서비스 계정 토큰을 쓰는 것을 권장한다.
- 버튼 값은 클라이언트가 보내는 값이라 `AGENT_TARGETS` 에 없는 대상은 거절한다.
- Slack 앱의 Interactivity 가 켜져 있어야 한다. Socket Mode 라 URL 은 필요 없다.

## 댓글 탭

원본은 Multica 이슈 댓글 한 곳이다. Slack 은 댓글을 저장하지 않고, 사용자가 카드의 댓글 탭을 열 때마다 `entity_comments_requested` 로 물어오면 서버가 Multica 댓글을 읽어 `entity.presentComments` 로 돌려준다. 같은 이슈 링크가 여러 채널에 올라가 있어도 어느 카드에서 열든 같은 목록이다.

- 카드의 댓글 링크는 엔티티 최상위 `entity_comments`(`count`, `latest_timestamp`)로 켠다.
- 작성자 표시: 멤버는 이메일로 Slack 계정을 찾아 프로필로, 에이전트는 이름 뒤에 `(agent)`. Slack 에서 쓴 댓글(`[Slack · 이름]` 머리말)은 머리말을 걷어 내고 그 사람으로 보여 준다.
- Slack 은 댓글 id 를 26자 미만으로 받는다. Multica 댓글 UUID(36자)를 base64url(22자)로 줄여 보내고, Slack 이 돌려주는 `thread_root_id` 는 다시 UUID 로 푼다.
- 최신 50개씩 보여 주고 이전 댓글은 커서로 넘긴다. 답글은 `thread_root_id` 로 따로 불러온다.
- 수정과 삭제는 막아 두었다. 쓰기가 토큰 하나로 들어가므로 열어 두면 남이 쓴 댓글을 Slack 에서 고칠 수 있게 된다.
- Slack 에서 댓글을 새로 쓰는 경로는 Slack 문서에 페이로드가 나와 있지 않아 아직 붙이지 않았다. 해당 요청은 `[observe]` 로그로 형태를 남긴다.

## Slack 앱 설정 (api.slack.com/apps)

`docs/unfurl.manifest-patch.json` 의 항목을 앱 manifest 에 더한다. `unfurl_domains` 는 Multica 웹 주소의 호스트로 바꾼다.

1. Work Object Previews 메뉴에서 토글을 켜고 Task 를 선택
2. Event Subscriptions 에 `link_shared`, `entity_details_requested`, `entity_comments_requested`, `message.channels`, `message.groups` 추가, App unfurl domains 에 Multica 웹 주소의 호스트
3. Bot scope `links:read`, `links:write`, `users:read`, `users:read.email`, `channels:history`, `groups:history` 추가 후 워크스페이스에 재설치
4. Socket Mode 를 켜고 `connections:write` 스코프로 app-level token(`xapp-`) 발급
5. Interactivity 켜기(버튼과 패널 편집용)

알려진 Slack 쪽 문제: 봇 display_name 이 영문이나 숫자가 아니면(예: 한글) manifest 검증이 "username 으로 바꿀 수 없다"로 실패하고, 이 때문에 Work Object Previews 화면에서 Task 를 추가해도 저장되지 않는다. display_name 을 영문으로 바꿔 manifest 를 저장한 뒤 App Home 에서 원래 이름으로 되돌린다.

## 기능 전용 환경변수

| 이름 | 값 |
|---|---|
| `AGENT_TARGETS` | "맡기기" 버튼 대상 JSON 배열(최대 4개). 예: `[{"label":"리뷰 에이전트에게 맡기기","type":"agent","id":"<agent id>"},{"label":"개발 스쿼드에 맡기기","type":"squad","id":"<squad id>"}]`. 비우면 맡기기 버튼이 없다 |

에이전트와 스쿼드 ID 는 `multica agent list`, `multica squad list` 로 확인한다. 공통 환경변수와 실행 방법은 루트 README 에 있다.

## 점검 스크립트

```bash
npm run unfurl:dry-run -- <이슈 URL>                                                   # Slack 없이 카드 데이터 확인
node --env-file=.env scripts/unfurl/unfurl-ts.js <channel> <ts> <url...>              # 올라간 메시지에 카드를 직접 붙여 Slack 스키마 검증
node --env-file=.env scripts/unfurl/post-card.js <channel> <thread_ts> <url>          # 카드를 단 메시지를 앱 이름으로 올려 보기
node --env-file=.env scripts/unfurl/post-as-bot.js <channel> <thread_ts> <text>       # unfurl_links=false 봇 메시지 재현
```

Socket Mode 라 인바운드 포트가 필요 없다. 운영은 작은 컨테이너 하나(0.25 vCPU / 512MB)면 된다.

## 남은 것

- 우측 패널 편집 저장(`view_submission`)은 문서 기준으로 구현했고, 실제 요청 형식과 다르면 맞춰야 한다.
- Slack 에서 댓글 쓰기.
- 커스텀 상태는 `status_name` 을 그대로 쓰고 색은 `status_category` 로 고른다.
