import { Telegraf, Context } from 'telegraf';
import { message, editedMessage } from 'telegraf/filters';
import { getEncoding } from 'js-tiktoken';
import telegramifyMarkdown from 'telegramify-markdown';
import { Message, Chat, Update } from 'telegraf/types';
import { ChatGPTAPI } from 'chatgpt';
// import { oraPromise } from 'ora';
import debounce from 'lodash.debounce';
import throttle from 'lodash.throttle';
import { watchFile } from 'fs';
import { ConfigType, ConfigChatType, ThreadStateType, CompletionParamsType } from './types.js';
import { readConfig } from './readConfig.js';

const threads = {} as { [key: number]: ThreadStateType };

const configPath = process.env.CONFIG || 'config.yml';
let config: ConfigType;
let bot: Telegraf<Context>;
let api: ChatGPTAPI;

// watch config file
watchFile(configPath, debounce(() => {
  console.log('reload config...');
  config = readConfig(configPath);
  console.log('config:', config);

  config.chats.filter(c => c.debug && threads[c.id]).forEach((c) => {
    console.log('clear debug chat:', c.name);
    forgetHistory(c.id);
    threads[c.id].customSystemMessage = '';
  });
}, 2000));

start();

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
  } catch (e) {
    console.log('restart after 5 seconds...');
    setTimeout(start, 5000);
  }
}

function addToHistory({ msg, systemMessage, completionParams }: {
  msg: Message.TextMessage;
  systemMessage?: string;
  completionParams?: CompletionParamsType;
}) {
  const key = msg.chat?.id || 0;
  if (!threads[key]) {
    threads[key] = {
      history: [],
      lastAnswer: undefined,
      partialAnswer: '',
      customSystemMessage: systemMessage || config.systemMessage,
      completionParams: completionParams || config.completionParams,
    };
  }
  threads[key].history.push(msg);
}

function forgetHistory(chatId: number) {
  threads[chatId].lastAnswer = undefined;
}

/*function getHistory(msg: Context) {
  return threads[msg.chat?.id || 0].history || [];
}*/

function getChatgptAnswer(msg: Message.TextMessage, chatConfig: ConfigChatType) {
  if (!msg.text) return;

  let systemMessage = threads[msg.chat?.id || 0]?.customSystemMessage || getSystemMessage(chatConfig);

  const date = new Date().toISOString();
  systemMessage = systemMessage.replace(/\{date}/g, date);

  let typingSent = false;
  return api.sendMessage(msg.text, {
    name: `${msg.from?.username}`,
    parentMessageId: threads[msg.chat.id].lastAnswer?.id,
    timeoutMs: config.timeoutMs || 60000,
    completionParams: threads[msg.chat.id].completionParams || config.completionParams,
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

function defaultSystemMessage() {
  return `You answer as concisely as possible for each response. If you are generating a list, do not have too many items.
Current date: ${new Date().toISOString()}\n\n`;
}

function getSystemMessage(chatConfig: ConfigChatType) {
  return threads[chatConfig.id]?.customSystemMessage || chatConfig.systemMessage || config.systemMessage || defaultSystemMessage();
}

function splitBigMessage(text: string) {
  const msgs: string[] = [];
  const sizeLimit = 4096;
  let msg = '';
  for (const line of text.split('\n')) {
      if (msg.length + line.length > sizeLimit) {
        console.log("split msg:", msg);
          msgs.push(msg);
          msg = '';
      }
      msg += line + '\n';
  }
  msgs.push(msg);
  return msgs;
}

function getTokensCount(text: string) {
  const tokenizer = getEncoding('cl100k_base');
  return tokenizer.encode(text).length;
}

async function onMessage(ctx: Context & { secondTry?: boolean }) {
  // console.log("ctx:", ctx);

  let ctxChat: Chat | undefined;
  let msg: Message.TextMessage | undefined;

  // edited message
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
    console.log('no ctx message detected');
    return;
  }

  if (!ctxChat) {
    console.log('no ctx chat detected');
    return;
  }

  let chat = config.chats.find(c => c.id == ctxChat?.id || 0) || {} as ConfigChatType;
  if (!chat.id) {
    // console.log("ctxChat:", ctxChat);
    if (ctxChat?.type !== 'private') {
      console.log(`This is ${ctxChat?.type} chat, not in whitelist: ${ctxChat.id}`);
      return;
    }

    if (ctxChat?.type === 'private') {
      const isAllowed = config.allowedPrivateUsers?.includes(ctxChat?.username || '');
      if (!isAllowed) {
        console.log(`Not in whitelist: }`, msg.from);
        return await ctx.telegram.sendMessage(ctxChat.id, `You are not allowed to use this bot.
Your username: ${msg.from?.username}`);
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
  addToHistory({
    msg,
    systemMessage: getSystemMessage(chat),
    completionParams: chat.completionParams,
  });

  // answer only to prefixed message
  if (chat.prefix) {
    const re = new RegExp(`^${chat.prefix}`, 'i');
    const isBot = re.test(msg.text);
    if (!isBot) {
      // console.log("not to bot:", ctx.chat);
      return;
    }
  }

  // skip replies to other people
  if (msg.reply_to_message && msg.from?.username !== msg.reply_to_message.from?.username) {
    if (msg.reply_to_message.from?.username !== config.bot_name) return;
  }

  // prog system message
  if (chat.progPrefix) {
    const re = new RegExp(`^${chat.progPrefix}`, 'i');
    const isProg = re.test(msg.text);
    if (isProg) {
      threads[msg.chat.id].customSystemMessage = msg.text.replace(re, '').trim();
      forgetHistory(msg.chat.id);
      if (threads[msg.chat.id].customSystemMessage === '') {
        return await ctx.telegram.sendMessage(msg.chat.id, 'Начальная установка сброшена');
      } else {
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
      const systemMessage = getSystemMessage(chat);
      const tokens = getTokensCount(systemMessage);
      let answer = 'Начальная установка: ' + systemMessage + '\n' + 'Токенов: ' + tokens + '\n';
      if (chat.completionParams?.model) {
        answer = `Модель: ${chat.completionParams.model}\n` + answer;
      }
      const msgs = splitBigMessage(answer);
      for (const text of msgs) {
          await ctx.telegram.sendMessage(msg.chat.id, text);
      }
      return;
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

  // send request to chatgpt
  try {
    threads[msg.chat.id].partialAnswer = '';
    const res = await getChatgptAnswer(msg, chat);
    threads[msg.chat.id].partialAnswer = '';
    if (config.debug) console.log('res:', res);
    if (!chat?.memoryless) threads[msg.chat.id].lastAnswer = res;

    // if (!ctx.message || !msg.chat) return;
    const text = telegramifyMarkdown(res?.text || 'бот не ответил');
    return await ctx.telegram.sendMessage(msg.chat.id, text, { ...extraMessageParams, ...{ parse_mode: 'MarkdownV2' } });
  } catch (e) {
    const error = e as { message: string };

    // token limit exceeded
    if (!ctx.secondTry && error.message.includes('maximum context')) {
      ctx.secondTry = true;
      forgetHistory(msg.chat.id);
      await onMessage(ctx);
    }

    if (threads[msg.chat.id].partialAnswer !== '') {
      // flush partial answer
      const answer = `бот ответил частично и забыл диалог:\n\nerror:\n\n${error.message}\n\n${threads[msg.chat.id].partialAnswer}`;
      forgetHistory(msg.chat.id);
      threads[msg.chat.id].partialAnswer = '';
      return await ctx.telegram.sendMessage(msg.chat.id, answer, extraMessageParams);
    } else {
      return await ctx.telegram.sendMessage(msg.chat.id, `error:\n\n${error.message}`, extraMessageParams);
    }
  }
}
