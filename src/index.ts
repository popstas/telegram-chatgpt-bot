import { Telegraf, Context } from 'telegraf';
import { message, editedMessage } from 'telegraf/filters';
import telegramifyMarkdown from 'telegramify-markdown';
import { Message, Chat, Update } from 'telegraf/types';
import { ChatGPTAPI } from 'chatgpt';
// import { oraPromise } from 'ora';
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import { watchFile } from 'fs';
import { ConfigType, ConfigChatType, ThreadStateType } from './types.js';
import { readConfig } from './readConfig.js';

const threads = {} as { [key: number]: ThreadStateType };

const configPath = 'config.yml';
let config: ConfigType;
let bot: Telegraf<Context>;
let api: ChatGPTAPI;
watchFile(configPath, debounce(() => {
  console.log("reload config...");
  config = readConfig(configPath);
  console.log("config:", config);
}, 2000));

function start() {
  config = readConfig(configPath);

  try {
    api = new ChatGPTAPI({
      apiKey: config.auth.chatgpt_api_key,
      completionParams: config.completionParams,
      debug: config.debug,
    });

    bot = new Telegraf(config.auth.bot_token);
    console.log('bot started');
    bot.on([message('text'), editedMessage('text')], onMessage);
    // bot.on('channel_post', onMessage);
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    bot.launch();
  }
  catch(e) {
    console.log("restart after 5 seconds...");
    setTimeout(start, 5000);
  }
}

start();

function addToHistory(msg: Message.TextMessage, systemMessage?: string) {
  const key = msg.chat?.id || 0;
  if (!threads[key]) {
    threads[key] = {
      history: [],
      lastAnswer: undefined,
      partialAnswer: '',
      customSystemMessage: systemMessage || config.systemMessage,
    };
  }
  threads[key].history.push(msg);
}

/*function getHistory(msg: Context) {
  return threads[msg.chat?.id || 0].history || [];
}*/

function getChatgptAnswer(msg: Message.TextMessage) {
  if (!msg.text) return;

  let systemMessage = defaultSystemMessage();
  if (threads[msg.chat?.id || 0]?.customSystemMessage) {
    systemMessage = threads[msg.chat.id].customSystemMessage || '';
  }

  let typingSent = false;
  return api.sendMessage(msg.text, {
    name: `${msg.from?.username}`,
    parentMessageId: threads[msg.chat.id].lastAnswer?.id,
    timeoutMs: config.timeoutMs || 60000,
    onProgress: throttle((partialResponse) => {
      // avoid send typing after answer
      if (!typingSent || threads[msg.chat.id].partialAnswer != '') {
        typingSent = true;
        bot.telegram.sendChatAction(msg.chat.id, 'typing');
      }

      threads[msg.chat.id].partialAnswer += partialResponse.text;
      // console.log(partialResponse.text);
    }, 4000),
    systemMessage,
  });
}

function forgetHistory(chatId: number) {
  threads[chatId].lastAnswer = undefined;
}

function defaultSystemMessage() {
  return `You answer as concisely as possible for each response. If you are generating a list, do not have too many items.
Current date: ${new Date().toISOString()}\n\n`;
}

function getSystemMessage(chatConfig: ConfigChatType) {
  return threads[chatConfig.id]?.customSystemMessage || chatConfig.systemMessage || config.systemMessage || defaultSystemMessage()
}

async function onMessage(ctx: Context & { secondTry?: boolean }) {
  console.log("ctx:", ctx);

  let ctxChat: Chat | undefined;
  let msg: Message.TextMessage | undefined;
  /*if (ctx.hasOwnProperty('message')) {
    msg = ctx.message as Message.TextMessage;
    ctxChat = ctx.chat;
    // console.log('no message in ctx');
    // return;
  }
  else*/

  if (ctx.hasOwnProperty('update')) {
    // console.log("ctx.update:", ctx.update);
    const updateEdited = ctx.update as Update.EditedMessageUpdate; //{ edited_message: Message.TextMessage, chat: Chat };
    const updateNew = ctx.update as Update.MessageUpdate;
    msg = (updateEdited.edited_message || updateNew.message) as Message.TextMessage;
    // console.log("msg:", msg);
    ctxChat = msg?.chat;
    // console.log('no message in ctx');
    // return;
  }

  if (!msg) {
    console.log("no ctx message detected");
    return;
  }

  if (!ctxChat) {
    console.log("no ctx chat detected");
    return;
  }

  console.log("ctxChat:", ctxChat);
  console.log("msg:", msg);

  let chat = config.chats.find(c => c.id == ctxChat?.id || 0) || {} as ConfigChatType;
  if (!chat.id) {
    console.log("ctxChat:", ctxChat);
    if (ctxChat?.type !== 'private') {
      console.log(`This is ${ctxChat?.type} chat, not in whitelist`);
      return;
    }

    if (ctxChat?.type === 'private') {
      const isAllowed = config.allowedPrivateUsers?.includes(ctxChat?.username || '')
      if (!isAllowed) {
        return await ctx.telegram.sendMessage(ctxChat.id, 'You are not allowed to use this bot');
      }
    }

    const defaultChat = config.chats.find(c => c.name === 'default');
    // console.log("defaultChat:", defaultChat);
    if (defaultChat) {
      chat = defaultChat;
    }
  }

  const extraMessageParams = { reply_to_message_id: ctx.message?.message_id };

  // console.log("ctx.message.text:", ctx.message?.text);
  addToHistory(msg, getSystemMessage(chat));

  if (chat.prefix) {
    const re = new RegExp(`^${chat.prefix}`, 'i');
    const isBot = re.test(msg.text);
    if (!isBot) {
      // console.log("not to bot:", ctx.chat);
      return;
    }
  }

  // prog system message
  if (chat.progPrefix) {
    const re = new RegExp(`^${chat.progPrefix}`, 'i');
    const isProg = re.test(msg.text);
    if (isProg) {
      const systemMessage = msg.text.replace(re, '').trim();
      threads[msg.chat.id].customSystemMessage = systemMessage;
      forgetHistory(msg.chat.id);
      if (threads[msg.chat.id].customSystemMessage === '') {
        return await ctx.telegram.sendMessage(msg.chat.id, 'Начальная установка сброшена');
      }
      else {
        threads[msg.chat.id].customSystemMessage = `Я ${threads[msg.chat.id].customSystemMessage}`;
        return await ctx.telegram.sendMessage(msg.chat.id, 'Сменил начальную установку на: ' + threads[msg.chat.id].customSystemMessage);
      }
    }
  }

  // prog info system message
  if (chat.progInfoPrefix) {
    const re = new RegExp(`^${chat.progInfoPrefix}`, 'i');
    const isProg = re.test(msg.text);
    if (isProg) {
      return await ctx.telegram.sendMessage(msg.chat.id, 'Начальная установка: ' + getSystemMessage(chat));
    }
  }

  // forget thread
  if (chat.forgetPrefix) {
    const re = new RegExp(`^${chat.forgetPrefix}`, 'i');
    const isForget = re.test(msg.text);
    if (isForget) {
      forgetHistory(msg.chat.id);
      return await ctx.telegram.sendMessage(msg.chat.id, 'OK');
    }
  }

  try {
    threads[msg.chat.id].partialAnswer = '';
    const res = await getChatgptAnswer(msg);
    threads[msg.chat.id].partialAnswer = '';
    if (config.debug) console.log('res:', res);
    threads[msg.chat.id].lastAnswer = res;
    // if (!ctx.message || !msg.chat) return;
    const text = telegramifyMarkdown(res?.text || 'бот не ответил');
    return await ctx.telegram.sendMessage(msg.chat.id, text, {...extraMessageParams, ...{ parse_mode: 'MarkdownV2' }});
  } catch (e) {
    const error = e as { message: string };

    if (!ctx.secondTry && error.message.includes('maximum context')) {
      ctx.secondTry = true;
      forgetHistory(msg.chat.id);
      onMessage(ctx);
    }

    if (threads[msg.chat.id].partialAnswer !== '') {
      const answer = `бот ответил частично и забыл диалог:\n\nerror:\n\n${error.message}\n\n${threads[msg.chat.id].partialAnswer}`;
      forgetHistory(msg.chat.id);
      threads[msg.chat.id].partialAnswer = '';
      return await ctx.telegram.sendMessage(msg.chat.id, answer, extraMessageParams);
    } else {
      return await ctx.telegram.sendMessage(msg.chat.id, `error:\n\n${error.message}`, extraMessageParams);
    }
  }
}
