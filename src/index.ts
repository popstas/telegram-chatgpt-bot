import { Telegraf, Context } from 'telegraf';
// import { message } from 'telegraf/filters';
import telegramifyMarkdown from 'telegramify-markdown';
import { Message } from 'telegraf/types';
import { ChatGPTAPI, ChatMessage } from 'chatgpt';
// import { oraPromise } from 'ora';
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import { watchFile } from 'fs';
// import { readConfig } from './readConfig'; // TODO: Cannot find module 'src/readConfig' imported from src/index.ts

import * as yaml  from 'js-yaml';
import { readFileSync } from 'fs';

type ThreadState = {
  lastAnswer?: ChatMessage
  partialAnswer: string
  history: Message.TextMessage[]
  customSystemMessage?: string
}

const threads = {} as { [key: number]: ThreadState };

type ConfigType = {
  debug?: boolean
  auth: {
    bot_token: string
    chatgpt_api_key: string
  },
  systemMessage?: string
  completionParams: {
    temperature?: number
    top_p?: number
  }
  chats: {
    name: string
    id: number
    prefix?: string
    progPrefix?: string
    forgetPrefix?: string
  }[]
}
function readConfig (path: string = 'config.yml') {
  const config = yaml.load(readFileSync(path, 'utf8')) as ConfigType;
  return config;
}
const configPath = 'config.yml';
let config = readConfig(configPath);
watchFile(configPath, debounce(() => {
  console.log("reload config...");
  config = readConfig(configPath);
  console.log("config:", config);
}, 2000));

const bot = new Telegraf(config.auth.bot_token);
console.log('bot started');
bot.on('text', onMessage);
bot.on('channel_post', onMessage);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
bot.launch();

const api = new ChatGPTAPI({
  apiKey: config.auth.chatgpt_api_key,
  completionParams: config.completionParams,
  debug: config.debug,
});

const history: { [key: number]: Message.TextMessage[] } = {};

let lastAnswer = {} as ChatMessage | undefined;
let partialAnswer = '';

let customSystemMessage = config.systemMessage;

function addToHistory(msg: Message.TextMessage) {
  const key = msg.chat?.id || 0;
  if (!threads[key]) {
    threads[key] = {
      history: [],
      lastAnswer: undefined,
      partialAnswer: '',
      customSystemMessage: config.systemMessage,
    };
  }
  threads[key].history.push(msg);
}

function getHistory(msg: Context) {
  return threads[msg.chat?.id || 0].history || [];
}

function getChatgptAnswer(msg: Message.TextMessage) {
  if (!msg.text) return;

  let systemMessage = `You answer as concisely as possible for each response. If you are generating a list, do not have too many items.
Current date: ${new Date().toISOString()}\n\n`;
  if (threads[msg.chat?.id || 0]?.customSystemMessage) {
    systemMessage = threads[msg.chat.id].customSystemMessage || '';
  }

  return api.sendMessage(msg.text, {
    // name: `${msg.from?.username}`,
    parentMessageId: threads[msg.chat.id].lastAnswer?.id,
    timeoutMs: config.timeoutMs || 60000,
    onProgress: throttle((partialResponse) => {
      // avoid send typing after answer
      if (!typingSent || threads[msg.chat.id].partialAnswer != '') {
        typingSent = true;
        bot.telegram.sendChatAction(msg.chat.id, 'typing');
      }

      threads[msg.chat.id].partialAnswer += partialResponse.text;
      console.log(partialResponse.text);
    }, 4000),
    systemMessage,
  });
}

async function onMessage(ctx: Context) {
  // console.log("ctx:", ctx);
  if (!('message' in ctx)) {
    console.log('no text in message');
    return;
  }

  const chat = config.chats.find(c => c.id == ctx.chat?.id || 0);
  if (!chat) {
    console.log('Unknown chat: ', ctx.chat);
    return;
  }

  // console.log("ctx.message.text:", ctx.message?.text);
  const msg = ctx.message as Message.TextMessage;
  addToHistory(msg);

  if (chat.prefix) {
    const re = new RegExp(`^${chat.prefix}`, 'i');
    const isBot = re.test(msg.text);
    if (!isBot) return;
  }

  // prog system message
  if (chat.progPrefix) {
    const re = new RegExp(`^${chat.progPrefix}`, 'i');
    const isProg = re.test(msg.text);
    if (isProg) {
      threads[msg.chat.id].customSystemMessage = msg.text.replace(chat.progPrefix, 'Ты');
      return await ctx.telegram.sendMessage(msg.chat.id, 'OK');
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
    const res = await getChatgptAnswer(msg);
    threads[msg.chat.id].partialAnswer = '';
    console.log('res:', res);
    threads[msg.chat.id].lastAnswer = res;
    // if (!ctx.message || !msg.chat) return;
    return await ctx.telegram.sendMessage(msg.chat.id, res?.text || 'бот не ответил');
  } catch (e) {
    if (threads[msg.chat.id].partialAnswer !== '') {
      const answer = `бот ответил частично и забыл диалог:\n\n${threads[msg.chat.id].partialAnswer}`;
      forgetHistory(msg.chat.id);
      threads[msg.chat.id].partialAnswer = '';
      return await ctx.telegram.sendMessage(msg.chat.id, answer);
    } else {
      return await ctx.telegram.sendMessage(msg.chat.id, `error:\n\n${(e as { message: string }).message}`); // TODO: ${e.message}
    }
  }
}
