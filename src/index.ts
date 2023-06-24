import { Telegraf, Context } from 'telegraf'
import { message, editedMessage } from 'telegraf/filters'
import { getEncoding } from 'js-tiktoken'
import telegramifyMarkdown from 'telegramify-markdown'
import { Message, Chat, Update } from 'telegraf/types'
import { ChatGPTAPI, ChatGPTError } from 'chatgpt'
// import { oraPromise } from 'ora';
import debounce from 'lodash.debounce'
import throttle from 'lodash.throttle'
import { watchFile } from 'fs'
import { ConfigType, ConfigChatType, ThreadStateType, CompletionParamsType, ConfigChatButtonType } from './types.js'
import { readConfig } from './readConfig.js'

const threads = {} as { [key: number]: ThreadStateType }

const configPath = process.env.CONFIG || 'config.yml'
let config: ConfigType
let bot: Telegraf<Context>
let api: ChatGPTAPI

// watch config file
watchFile(configPath, debounce(() => {
  console.log('reload config...')
  config = readConfig(configPath)
  console.log('config:', config)

  config.chats.filter(c => c.debug && threads[c.id]).forEach((c) => {
    console.log('clear debug chat:', c.name)
    forgetHistory(c.id)
    threads[c.id].customSystemMessage = ''
  })
}, 2000))

/*onunhandledrejection = (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
}*/

process.on('uncaughtException', (error, source) => {
  console.log('Uncaught Exception:', error)
  console.log('source:', source)
})

start()

function start () {
  config = readConfig(configPath)

  try {
    api = new ChatGPTAPI({
      apiKey: config.auth.chatgpt_api_key,
      completionParams: config.completionParams,
      debug: config.debug,
      maxResponseTokens: config.completionParams.max_tokens || 0,
    })

    bot = new Telegraf(config.auth.bot_token)
    console.log('bot started')
    bot.on([message('text'), editedMessage('text')], onMessage)
    // bot.on('channel_post', onMessage);
    process.once('SIGINT', () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
    bot.launch()
  } catch (e) {
    console.log('restart after 5 seconds...')
    setTimeout(start, 5000)
  }
}

function addToHistory ({ msg, systemMessage, completionParams }: {
  msg: Message.TextMessage;
  systemMessage?: string;
  completionParams?: CompletionParamsType;
}) {
  const key = msg.chat?.id || 0
  if (!threads[key]) {
    threads[key] = {
      history: [],
      lastAnswer: undefined,
      partialAnswer: '',
      customSystemMessage: systemMessage || config.systemMessage,
      completionParams: completionParams || config.completionParams,
    }
  }
  threads[key].history.push(msg)
}

function forgetHistory (chatId: number) {
  threads[chatId].lastAnswer = undefined
}

/*function getHistory(msg: Context) {
  return threads[msg.chat?.id || 0].history || [];
}*/

function getChatgptAnswer (msg: Message.TextMessage, chatConfig: ConfigChatType) {
  if (!msg.text) return

  const thread = threads[msg.chat?.id || 0]
  let systemMessage = thread?.customSystemMessage || getSystemMessage(chatConfig)
  if (thread?.nextSystemMessage) {
    systemMessage = thread.nextSystemMessage || ''
    thread.nextSystemMessage = ''
  }

  const date = new Date().toISOString()
  systemMessage = systemMessage.replace(/\{date}/g, date)

  let typingSent = false
  return api.sendMessage(msg.text, {
    name: `${msg.from?.username}`,
    parentMessageId: thread.lastAnswer?.id,
    timeoutMs: config.timeoutMs || 60000,
    completionParams: thread.completionParams || config.completionParams,
    onProgress: throttle((partialResponse) => {
      // avoid send typing after answer
      if (!typingSent || thread.partialAnswer != '') {
        typingSent = true
        bot.telegram.sendChatAction(msg.chat.id, 'typing')
      }

      thread.partialAnswer += partialResponse.text
      // console.log(partialResponse.text);
    }, 4000),
    systemMessage,
  })
}

function defaultSystemMessage () {
  return `You answer as concisely as possible for each response. If you are generating a list, do not have too many items.
Current date: ${new Date().toISOString()}\n\n`
}

function getSystemMessage (chatConfig: ConfigChatType) {
  return threads[chatConfig.id]?.customSystemMessage || chatConfig.systemMessage || config.systemMessage || defaultSystemMessage()
}

function splitBigMessage (text: string) {
  const msgs: string[] = []
  const sizeLimit = 4096
  let msg = ''
  for (const line of text.split('\n')) {
    if (msg.length + line.length > sizeLimit) {
      // console.log("split msg:", msg);
      msgs.push(msg)
      msg = ''
    }
    msg += line + '\n'
  }
  msgs.push(msg)
  return msgs
}

async function sendTelegramMessage (chat_id: number, text: string, extraMessageParams?: any) {
  return new Promise((resolve) => {

    const msgs = splitBigMessage(text)
    if (msgs.length > 1) console.log(`Split into ${msgs.length} messages`)

    const params = {
      ...extraMessageParams,
      // disable_web_page_preview: true,
      // disable_notification: true,
      // parse_mode: 'HTML'
    }

    msgs.forEach(async (msg) => {
      await bot.telegram.sendMessage(chat_id, msg, params)
    })
    resolve(true)
  })
}

function getTokensCount (text: string) {
  const tokenizer = getEncoding('cl100k_base')
  return tokenizer.encode(text).length
}

async function onMessage (ctx: Context & { secondTry?: boolean }) {
  // console.log("ctx:", ctx);

  let ctxChat: Chat | undefined
  let msg: Message.TextMessage | undefined

  // edited message
  if (ctx.hasOwnProperty('update')) {
    // console.log("ctx.update:", ctx.update);
    const updateEdited = ctx.update as Update.EditedMessageUpdate //{ edited_message: Message.TextMessage, chat: Chat };
    const updateNew = ctx.update as Update.MessageUpdate
    msg = (updateEdited.edited_message || updateNew.message) as Message.TextMessage
    // console.log("msg:", msg);
    ctxChat = msg?.chat
    // console.log('no message in ctx');
    // return;
  }

  if (!msg) {
    console.log('no ctx message detected')
    return
  }

  if (!ctxChat) {
    console.log('no ctx chat detected')
    return
  }

  let chat = config.chats.find(c => c.id == ctxChat?.id || 0) || {} as ConfigChatType
  if (!chat.id) {
    // console.log("ctxChat:", ctxChat);
    if (ctxChat?.type !== 'private') {
      console.log(`This is ${ctxChat?.type} chat, not in whitelist: ${ctxChat.id}`)
      return
    }

    // default chat, with name 'default'
    const defaultChat = config.chats.find(c => c.name === 'default')
    // console.log("defaultChat:", defaultChat);
    if (defaultChat) chat = defaultChat

    if (ctxChat?.type === 'private') {
      const privateChat = ctxChat as Chat.PrivateChat
      const isAllowed = config.allowedPrivateUsers?.includes(privateChat.username || '')
      if (!isAllowed) {
        console.log(`Not in whitelist: }`, msg.from)
        return await ctx.telegram.sendMessage(ctxChat.id, `You are not allowed to use this bot.
Your username: ${msg.from?.username}`)
      }

      // user chat, with username
      const userChat = config.chats.find(c => c.username === privateChat.username || '')
      if (userChat) chat = { ...defaultChat, ...userChat }
    }

    if (!chat && defaultChat) chat = defaultChat
  }

  // console.log('chat:', chat)
  const extraMessageParams = { reply_to_message_id: ctx.message?.message_id }

  // console.log("ctx.message.text:", ctx.message?.text);
  addToHistory({
    msg,
    systemMessage: getSystemMessage(chat),
    completionParams: chat.completionParams,
  })

  const thread = threads[msg.chat.id]

  // replace msg.text to button.prompt if match button.name
  let matchedButton: ConfigChatButtonType | undefined = undefined
  const activeButton = thread.activeButton
  if (chat.buttons) {

    // message == button.name
    matchedButton = chat.buttons.find(b => b.name === msg?.text || '')
    if (matchedButton) {
      msg.text = matchedButton.prompt || ''

      // send ask for text message
      if (matchedButton.waitMessage) {
        thread.activeButton = matchedButton
        return await sendTelegramMessage(msg.chat.id, matchedButton.waitMessage, extraMessageParams)
      }
    }

    // received text, send prompt with text in the end
    if (activeButton) {
      forgetHistory(msg.chat.id)
      thread.nextSystemMessage = activeButton.prompt
      thread.activeButton = undefined
    }
  }

  // answer only to prefixed message
  if (chat.prefix && !matchedButton && !activeButton) {
    const re = new RegExp(`^${chat.prefix}`, 'i')
    const isBot = re.test(msg.text)
    if (!isBot) {
      // console.log("not to bot:", ctx.chat);
      return
    }
  }

  // skip replies to other people
  if (msg.reply_to_message && msg.from?.username !== msg.reply_to_message.from?.username) {
    if (msg.reply_to_message.from?.username !== config.bot_name) return
  }

  // prog system message
  if (chat.progPrefix) {
    const re = new RegExp(`^${chat.progPrefix}`, 'i')
    const isProg = re.test(msg.text)
    if (isProg) {
      thread.customSystemMessage = msg.text.replace(re, '').trim()
      forgetHistory(msg.chat.id)
      if (thread.customSystemMessage === '') {
        return await ctx.telegram.sendMessage(msg.chat.id, 'Начальная установка сброшена')
      } else {
        thread.customSystemMessage = `Я ${thread.customSystemMessage}`
        return await sendTelegramMessage(msg.chat.id, 'Сменил начальную установку на: ' + thread.customSystemMessage)
      }
    }
  }

  // prog info system message
  if (chat.progInfoPrefix) {
    const re = new RegExp(`^${chat.progInfoPrefix}`, 'i')
    const isProg = re.test(msg.text)
    if (isProg) {
      const systemMessage = getSystemMessage(chat)
      const tokens = getTokensCount(systemMessage)
      let answer = 'Начальная установка: ' + systemMessage + '\n' + 'Токенов: ' + tokens + '\n'
      if (chat.completionParams?.model) {
        answer = `Модель: ${chat.completionParams.model}\n\n` + answer
      }
      return sendTelegramMessage(msg.chat.id, answer)
    }
  }

  // forget thread
  if (chat.forgetPrefix) {
    const re = new RegExp(`^${chat.forgetPrefix}`, 'i')
    const isForget = re.test(msg.text)
    if (isForget) {
      forgetHistory(msg.chat.id)
      return await ctx.telegram.sendMessage(msg.chat.id, 'OK')
    }
  }

  // send request to chatgpt
  try {
    thread.partialAnswer = ''
    const res = await getChatgptAnswer(msg, chat)
    thread.partialAnswer = ''
    if (config.debug) console.log('res:', res)
    if (!chat?.memoryless) thread.lastAnswer = res
    // console.log("res:", res);

    // if (!ctx.message || !msg.chat) return;
    const text = telegramifyMarkdown(res?.text || 'бот не ответил')
    const extraParams: any = {
      ...extraMessageParams,
      ...{ parse_mode: 'MarkdownV2' }
    }
    if (chat.buttons) {
      const buttonRows: { text: string }[][] = [[]]
      chat.buttons.forEach(b => {
        b.row = b.row || 1
        const index = b.row - 1
        buttonRows[index] = buttonRows[index] || []
        buttonRows[index].push({ text: b.name })
      })
      extraParams.reply_markup = { keyboard: buttonRows, resize_keyboard: true }
    }

    return await sendTelegramMessage(msg.chat.id, text, extraParams)
  } catch (e) {
    const error = e as ChatGPTError & { message: string }
    console.log('error:', error)
    // console.log("error.message:", error.message);
    // console.log("typeof error.message:", typeof error.message);

    if (ctx.secondTry) return

    // token limit exceeded
    if (!ctx.secondTry && error.message.includes('context_length_exceeded')) {
      ctx.secondTry = true
      forgetHistory(msg.chat.id)
      onMessage(ctx) // специально без await
    }

    if (thread.partialAnswer !== '') {
      // flush partial answer
      const answer = `Бот ответил частично и забыл диалог:\n\n${error.message}\n\n${thread.partialAnswer}`
      forgetHistory(msg.chat.id)
      thread.partialAnswer = ''
      return await sendTelegramMessage(msg.chat.id, answer, extraMessageParams)
    } else {
      return await sendTelegramMessage(msg.chat.id, `${error.message}${ctx.secondTry ? '\n\nПовторная отправка последнего сообщения...' : ''}`, extraMessageParams)
    }
  }
}
