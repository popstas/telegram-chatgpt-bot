Just Telegram bot with ChatGPT. Nothing interesting.

ChatGPT API docs - https://platform.openai.com/docs/api-reference/chat

Nodejs api lib docs - https://github.com/transitive-bullshit/chatgpt-api

Telegram bot lib docs - [Telegraf](https://github.com/feathers-studio/telegraf-docs)

## Override config for user's direct chat by username
```yml
chats:
  - name: default
    id: 0
    progPrefix: бот, ты теперь
    progInfoPrefix: бот, начальные установки
    forgetPrefix: бот, забудь

  - name: user's direct
    username: popstas
    completionParams:
      model: gpt-4
      max_tokens: 4000
```